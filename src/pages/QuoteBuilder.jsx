import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Hash, AlertCircle, PackageSearch, Share2, Eye } from 'lucide-react';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { computeTotals, lineForTotals } from '../lib/pricing.js';
import { groupFamilies } from '../lib/catalog.js';
import { effectiveRates, displayRatesFor } from '../lib/exchangeRate.js';
import { LINE_KIND_ITEM, isPricedLine } from '../lib/constants.js';
import { useKeyboardShortcut, shortcutLabel } from '../lib/useKeyboardShortcut.js';
import { DebouncedTextarea } from '../components/DebouncedInput.jsx';

import QuoteHeader from '../components/quote-builder/QuoteHeader.jsx';
import QuoteStatusStepper from '../components/quote-builder/QuoteStatusStepper.jsx';
import LineItemList from '../components/quote-builder/LineItemList.jsx';
import { FamiliesContext } from '../components/quote-builder/QuoteLineItem.jsx';
import { QuoteActionsContext, useQuoteActions } from '../components/quote-builder/QuoteActionsContext.js';
import TotalsDock from '../components/quote-builder/TotalsDock.jsx';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import QuickActions from '../components/quote-builder/QuickActions.jsx';
import CatalogPicker from '../components/quote-builder/CatalogPicker.jsx';
import { useQuoteController } from '../components/quote-builder/useQuoteController.js';
import { useQuoteExport } from '../components/quote-builder/useQuoteExport.js';

/**
 * The Quote Workspace — the redesigned quote builder.
 *
 * Layout is a single editable canvas with a persistent totals rail on the
 * right. The price-list PDF replaces the rail (becomes the right column)
 * when toggled — the rail collapses into a compact strip below the line
 * items so the running total stays visible.
 *
 * The "Vista cliente" toggle in the header swaps the line items area for a
 * read-only `ClientPreview` of the quote, styled like the PDF, so the dealer
 * can show the client what they're getting without downloading a file.
 *
 * Lines are still free-form (typed from the price-list PDF). The command
 * palette (⌘K) surfaces past-quote line items as insertable suggestions —
 * our catalog substitute that grows with usage.
 */
export default function QuoteBuilder() {
  const navigate = useNavigate();
  const { profileId, settings, currentProfile } = useApp();
  const { quoteId: routeId } = useParams();
  const [search] = useSearchParams();

  if (routeId) return <Workspace quoteId={routeId} navigate={navigate} />;

  return (
    <DraftWorkspace
      profileId={profileId}
      settings={settings}
      // currentProfile.id is auth.uid() for the signed-in user. We stamp
      // it on every new quote so the monthly commissions report can
      // attribute the deal back to whoever closed it. Old quotes
      // without this field are skipped by the report rather than
      // credited to a random dealer.
      createdByUserId={currentProfile?.id || null}
      initialRef={search.get('ref') || ''}
      navigate={navigate}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Draft → Materialize                                                       */
/* -------------------------------------------------------------------------- */

function DraftWorkspace({ profileId, settings, createdByUserId, initialRef, navigate }) {
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = newId();
  const id = idRef.current;

  const defaults = useMemo(() => ({
    id,
    profileId,
    createdByUserId,
    number: null,
    customerId: null,
    professionalId: null,
    commissionPct: null,
    orderType: 'floor',
    orderId: null,
    status: 'draft',
    currencyCode: 'USD',
    rates: effectiveRates(settings),
    marginPct: settings?.defaultMarginPct || 0,
    discountPct: settings?.defaultDiscountPct || 0,
    shipping: 0,
    terms: settings?.quoteTerms || '',
    notes: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }), [id, profileId, settings, createdByUserId]);

  const persistedRef = useRef(false);
  const inFlightRef = useRef(null);

  const materialize = useCallback(async () => {
    if (persistedRef.current) return id;
    if (inFlightRef.current) return inFlightRef.current;
    inFlightRef.current = (async () => {
      try {
        // Derive the number from the table's current top, not a stored
        // counter — see nextSequenceNumber's docstring for why. The
        // assign-helper handles the read+write race under multi-user
        // load: if another browser took our number, it retries
        // against the new max instead of failing.
        await assignSequenceNumber({
          table: 'quotes',
          profileId,
          start: 1001,
          build: (number) => ({ ...defaults, number, updatedAt: Date.now() }),
        });
        persistedRef.current = true;
        try { window.history.replaceState(null, '', `#/quotes/${id}`); } catch {}
        return id;
      } catch (e) {
        inFlightRef.current = null;
        throw e;
      }
    })();
    return inFlightRef.current;
  }, [id, defaults, profileId]);

  // ?ref=XXXXX pre-fills the first line's reference field after materialize.
  useEffect(() => {
    if (!initialRef) return;
    let cancel = false;
    (async () => {
      await materialize();
      if (cancel) return;
      await db.quoteLines.put({
        id: newId(),
        quoteId: id,
        kind: LINE_KIND_ITEM,
        sortOrder: 0,
        family: '',
        reference: initialRef,
        name: '',
        subtype: '',
        dimensions: '',
        description: '',
        pageRef: '',
        imageId: null,
        qty: 1,
        unitPrice: 0,
        lineMarginPct: 0,
        lineDiscountPct: 0,
        notes: '',
      });
    })();
    return () => { cancel = true; };
  }, [initialRef]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Workspace
      quoteId={id}
      navigate={navigate}
      draftQuote={defaults}
      materialize={materialize}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Workspace                                                                  */
/* -------------------------------------------------------------------------- */

function Workspace({ quoteId, navigate, draftQuote, materialize }) {
  const { settings, profileId, profiles } = useApp();
  const dbQuote = useLiveQuery(() => db.quotes.get(quoteId), [quoteId], null);
  const baseQuote = dbQuote || draftQuote || null;
  // Resolve the exchange rate the editor (and everything it feeds —
  // totals rail, line items, client preview, PDF export) renders with.
  // While a quote is a DRAFT it tracks the live published rate from
  // Settings, so the dealer always builds against today's number. Once
  // the quote is SENT the rate is locked to the snapshot taken at send
  // time (displayRatesFor returns baseQuote.rates), so a later rate
  // change can't move a figure the client has already seen.
  const quote = useMemo(() => {
    if (!baseQuote) return null;
    return { ...baseQuote, rates: displayRatesFor(baseQuote, settings) };
  }, [baseQuote, settings]);
  const lines = useLiveQuery(
    () => db.quoteLines.where('quoteId').equals(quoteId).sortBy('sortOrder'),
    [quoteId],
    [],
  );
  // Per-group attributes (is_optional) for Conjuntos / Alternativas, keyed by
  // the same id the lines carry in setGroup / alternativeGroup.
  const groups = useLiveQuery(
    () => db.quoteGroups.where('quoteId').equals(quoteId).toArray(),
    [quoteId],
    [],
  );
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const professionals = useLiveQuery(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  // Catalog products → families, keyed by SKU root. Feeds the material-options
  // delta math (QuoteLineItem resolves a line's family from its reference) and
  // the client preview's preview-side deltas (passed down as `families`). The
  // product table is small enough to hold in memory; grouping is memoised.
  const products = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId],
    [],
  );
  const families = useMemo(() => {
    const map = new Map();
    for (const fam of groupFamilies(products)) map.set(fam.root, fam);
    return map;
  }, [products]);

  const ensurePersisted = useCallback(async () => {
    if (materialize) await materialize();
  }, [materialize]);

  // The editor's logic core — every quote/line mutation, the undo/redo
  // history machine, and the save indicator — lives in useQuoteController so
  // this component is mostly UI + wiring. Destructured into the same local
  // names the JSX and the QuoteActionsContext below already use, so only the
  // SOURCE of these handlers moved, not their call sites.
  const {
    saving, savedAt, focusLineId,
    canUndo, canRedo, undo, redo, hx, undoToast,
    updateQuote, addLine, addSection, updateLine, duplicateLine,
    toggleOptional, addAlternative, selectAlternative, separateFromSet,
    toggleGroupOptional, joinSet, ungroupLine, removeLine, reorderLines,
  } = useQuoteController({ quoteId, quote, lines, groups, settings, ensurePersisted });

  // PDF export + share-link logic lives in its own hook so the export UI
  // (TotalsDock, the banners below) stays thin. It persists the share token
  // through updateQuote — the single quote writer from the controller above.
  const {
    exporting, exportError, setExportError,
    sharing, shareMsg, setShareMsg, exportErrorRef,
    exportPdf, shareQuote,
  } = useQuoteExport({ quote, settings, lines, customers, professionals, profiles, groups, families, updateQuote });

  // Heal legacy quotes that lost their sequence number to the old
  // updateQuote write-back race (it persisted the stale in-memory quote,
  // number:null, right after materialize had assigned one). Assign the
  // next number in place the first time such a quote is opened; race-safe
  // so two tabs don't double-assign. New drafts can't reach here — they
  // get their number at materialize and updateQuote now preserves it.
  useEffect(() => {
    if (!dbQuote || dbQuote.number != null || !profileId) return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await db.quotes.get(quoteId);
        if (cancelled || !fresh || fresh.number != null) return;
        await assignSequenceNumber({
          table: 'quotes',
          profileId,
          start: 1001,
          build: (number) => ({ ...fresh, number, updatedAt: Date.now() }),
        });
      } catch (e) {
        console.warn('[QuoteBuilder] could not heal missing quote number:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [dbQuote, quoteId, profileId]);

  // -------- view + panel state --------
  // The "lista de precios" PDF panel (a `pdfjs-dist` viewer that slid
  // in from the right with the LR price list) was removed entirely —
  // including the upload affordance in Settings, the panel toggle in
  // the header, and the pdfjs-dist dependency itself. The quote
  // builder now stays focused on quote construction; price-list lookup
  // happens outside the app.
  const [view, setView] = useState('compose'); // 'compose' | 'client'
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);

  /* ---------------------------- shortcuts ----------------------------
   * Kept deliberately small to avoid clashing with the browser:
   *   ⌘K       — open the command palette (the universal launcher)
   *   ⌘↵       — open the catalog to add a product (works even inside an input)
   *   ⌘P       — export PDF (commandeers the browser's print shortcut on
   *              purpose — the PDF IS the print equivalent for this app)
   * The client-view toggle is intentionally NOT bound — every browser has
   * its own ⌘E meaning, and the palette + header toggle cover the need.
   *
   * These hooks live above the `!quote` guard so the hook count stays
   * stable between the initial "loading" render and the post-load render.
   * The handlers are hoisted function declarations, so referencing them
   * before their lexical position is fine; they're only invoked on user
   * keypress, by which point `quote` is populated.
   */
  useKeyboardShortcut('mod+k', () => setPaletteOpen((v) => !v));
  useKeyboardShortcut('mod+enter', () => setCatalogOpen(true), { ignoreInInput: false });
  useKeyboardShortcut('mod+p', () => exportPdf(), { ignoreInInput: false });

  if (!quote) return <div className="text-sm text-ink-500">Cargando…</div>;

  const totals = computeTotals(
    lines.filter(isPricedLine).map(lineForTotals),
    { marginPct: quote.marginPct, discountPct: quote.discountPct, shipping: quote.shipping },
  );

  /* ---------------------------- render ---------------------------- */

  const customer = quote.customerId ? customers.find((c) => c.id === quote.customerId) : null;
  const professional = quote.professionalId ? professionals.find((p) => p.id === quote.professionalId) : null;
  const seller = quote.createdByUserId ? (profiles || []).find((p) => p.id === quote.createdByUserId) : null;

  return (
    <>
      <QuoteHeader
        quote={quote}
        customers={customers}
        professionals={professionals}
        profileId={profileId}
        view={view}
        onViewChange={setView}
        onOpenPalette={() => setPaletteOpen(true)}
        onUpdateQuote={hx(updateQuote)}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        savedAt={savedAt}
        saving={saving}
      />

      {/* Surface PDF export failures inline. The export button used to
          fail silently in iOS-PWA standalone — now if anything throws
          (gesture timed out, share sheet rejected, generator crashed),
          the dealer sees a dismissible banner with the underlying
          message instead of just "I tapped it and nothing happened". */}
      {exportError && (
        <div ref={exportErrorRef} role="alert" className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">No se pudo exportar el PDF</div>
            <div className="text-red-700">{exportError}</div>
          </div>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="text-red-700 hover:text-red-900 text-[11px] underline"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Share-link toast — the copied URL (or a manual-copy fallback). */}
      {shareMsg && (
        <div role="status" className="mb-4 rounded-md bg-ink-900 text-white px-3 py-2 text-xs flex items-start gap-2">
          <Share2 size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1 break-all">{shareMsg}</div>
          <button type="button" onClick={() => setShareMsg(null)} className="text-white/70 hover:text-white text-[11px] underline">Cerrar</button>
        </div>
      )}

      {/* Non-destructive notice that the client interacted with the share
          link (plan A — their picks live in quote.clientSelections, separate
          from the dealer's own lines). */}
      {quote.clientSelections && (quote.clientSelections.alternatives || quote.clientSelections.optionals) && (
        <div className="mb-4 rounded-md bg-brand-50 border border-brand-200 px-3 py-2 text-xs text-brand-800 flex items-start gap-2">
          <Eye size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            El cliente personalizó esta cotización desde el enlace
            {' '}({Object.keys(quote.clientSelections.alternatives || {}).length} alternativa(s),
            {' '}{Object.values(quote.clientSelections.optionals || {}).filter(Boolean).length} complemento(s)).
            Sus selecciones se guardan aparte; tus líneas no cambian.
          </div>
        </div>
      )}

      <div className="mb-5">
        <QuoteStatusStepper quote={quote} onTransition={updateQuote} />
      </div>

      {view === 'client' ? (
        <ClientPreview
          quote={quote}
          settings={settings}
          lines={lines}
          quoteGroups={groups}
          totals={totals}
          customer={customer}
          professional={professional}
          seller={seller}
          families={families}
        />
      ) : (
        // Single full-width column: the totals live in the persistent bottom
        // dock now (not a right rail), so the line items get the full width.
        // `min-w-0` lets the column shrink below its content's intrinsic width,
        // so a long money value / dimension spec can't force a horizontal scroll.
        <div className="space-y-5 min-w-0">
          {/* Provide catalog families to every line item below (through the
              LineItemList, which doesn't thread per-line catalog props) so
              the material-options chips can show list-price deltas. */}
          {/* Editor actions flow via QuoteActionsContext instead of being
              threaded Workspace → LineItemsCard → LineItemList; catalog
              families already do the same via FamiliesContext. The item tree
              subscribes to the logic it needs, so re-nesting the UI doesn't
              re-plumb handlers. History-wrapping (hx) stays here at the source
              — note onToggleGroupOptional is intentionally NOT wrapped, as
              before. */}
          <QuoteActionsContext.Provider value={{
            onToggleGroupOptional: toggleGroupOptional,
            onChangeLine: hx(updateLine),
            onRemoveLine: hx(removeLine),
            onDuplicateLine: hx(duplicateLine),
            onToggleOptional: hx(toggleOptional),
            onAddAlternative: hx(addAlternative),
            onSelectAlternative: hx(selectAlternative),
            onSeparateFromSet: hx(separateFromSet),
            onUngroup: hx(ungroupLine),
            onJoinSet: hx(joinSet),
            onReorder: hx(reorderLines),
            onAddSection: hx(addSection),
            onOpenCatalog: () => setCatalogOpen(true),
          }}>
            <FamiliesContext.Provider value={families}>
              <LineItemsCard
                lines={lines}
                groups={groups}
                quote={quote}
                focusLineId={focusLineId}
              />
            </FamiliesContext.Provider>
          </QuoteActionsContext.Provider>
          <NotesAndTermsCard quote={quote} onUpdateQuote={hx(updateQuote)} />
        </div>
      )}

      {/* Spacer so the last content can scroll clear of the fixed bottom dock
          (sized to the collapsed bar: label + amount + DOP line + safe area). */}
      <div className="h-[calc(5rem+env(safe-area-inset-bottom))]" aria-hidden />

      {/* Persistent totals dock — pinned to the bottom of the screen at every
          width, replacing the old desktop right-rail and the mobile totals bar. */}
      <TotalsDock
        quote={quote}
        totals={totals}
        professional={professional}
        onUpdateQuote={hx(updateQuote)}
        onOpenCatalog={() => setCatalogOpen(true)}
        onExport={exportPdf}
        exporting={exporting}
        onShare={shareQuote}
        sharing={sharing}
      />

      <QuickActions
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        customers={customers}
        currentCustomerId={quote.customerId}
        onInsertLine={hx((seed) => addLine(seed))}
        onAddSection={hx(addSection)}
        onOpenCatalog={() => setCatalogOpen(true)}
        onSelectCustomer={hx((id) => updateQuote({ customerId: id }))}
        onExportPdf={exportPdf}
        onToggleClientView={() => setView((v) => v === 'compose' ? 'client' : 'compose')}
        clientView={view === 'client'}
        currency={quote.currencyCode || 'USD'}
        rates={quote.rates || { USD: 1 }}
      />

      <CatalogPicker
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onInsert={hx((seed) => addLine(seed))}
      />

      {undoToast}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sub-cards                                                                  */
/* -------------------------------------------------------------------------- */

function LineItemsCard({ lines, groups, quote, focusLineId }) {
  // The header/footer add buttons use just these two; LineItemList subscribes
  // to the rest of the editor actions from context itself.
  const { onAddSection, onOpenCatalog } = useQuoteActions();
  return (
    <div className="card overflow-hidden">
      <header className="card-header">
        <h2>Artículos</h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAddSection}
            className="btn-ghost text-xs hidden sm:inline-flex"
            title="Agregar sección"
          >
            <Hash size={12} /> Sección
          </button>
          {/* Catalog is the ONLY add path — picking a real product fills the
              line (ref, name, price, cost, grade/fabric) instead of leaving the
              dealer to type everything from the paper price list. */}
          <button
            type="button"
            onClick={onOpenCatalog}
            className="btn-primary"
            title={`Elegir un producto del catálogo (${shortcutLabel('mod+enter')})`}
          >
            <PackageSearch size={18} /> Catálogo
          </button>
        </div>
      </header>
      <LineItemList
        lines={lines}
        groups={groups}
        quote={quote}
        focusLineId={focusLineId}
      />
      {lines.length > 0 && (
        <div className="px-5 py-3 border-t border-ink-100 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-500">
            {lines.filter(isPricedLine).length} artículo(s) · arrastra
            <span className="font-mono"> ⋮⋮ </span>para reordenar
          </span>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={onAddSection} className="btn-ghost text-xs">
              <Hash size={12} /> Sección
            </button>
            <button type="button" onClick={onOpenCatalog} className="btn-secondary text-xs">
              <PackageSearch size={16} /> Catálogo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NotesAndTermsCard({ quote, onUpdateQuote }) {
  return (
    <div className="card card-pad space-y-4">
      <h2 className="font-semibold text-sm">Notas y términos</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label flex items-center justify-between">
            <span>Notas internas</span>
            <span className="text-[9px] text-ink-400 normal-case tracking-normal">solo equipo</span>
          </div>
          <DebouncedTextarea
            className="input min-h-[100px]"
            value={quote.notes || ''}
            onCommit={(v) => onUpdateQuote({ notes: v })}
            placeholder="Información que solo ve tu equipo."
          />
        </div>
        <div>
          <div className="label flex items-center justify-between">
            <span>Términos</span>
            <span className="text-[9px] text-ink-400 normal-case tracking-normal">se imprimen en el PDF</span>
          </div>
          <DebouncedTextarea
            className="input min-h-[100px]"
            value={quote.terms || ''}
            onCommit={(v) => onUpdateQuote({ terms: v })}
            placeholder="Validez, plazos de entrega, condiciones de pago…"
          />
        </div>
      </div>
    </div>
  );
}
