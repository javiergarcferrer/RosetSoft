import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Hash, Download, AlertCircle, Loader2 } from 'lucide-react';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { computeTotals, lineForTotals } from '../lib/pricing.js';
import { effectiveRates } from '../lib/exchangeRate.js';
import { LINE_KIND_ITEM, LINE_KIND_SECTION, isPricedLine } from '../lib/constants.js';
import { formatMoney } from '../lib/format.js';
// PDF generation (pdf-lib + fontkit + embedded Inter) is heavy — ~600KB
// gzipped between pdf-lib, fontkit, and the font fetch. Loading it
// eagerly would bloat every page that imports QuoteBuilder. Dynamic
// import keeps it out of the initial bundle and fetched only when the
// dealer first taps Export PDF — the browser caches the chunk after
// that, so subsequent exports in the same session are free.
import { useKeyboardShortcut, shortcutLabel } from '../lib/useKeyboardShortcut.js';
import { safeDynamicImport } from '../lib/dynamicImport.js';
import { DebouncedTextarea } from '../components/DebouncedInput.jsx';

import QuoteHeader from '../components/quote-builder/QuoteHeader.jsx';
import QuoteStatusStepper from '../components/quote-builder/QuoteStatusStepper.jsx';
import LineItemList from '../components/quote-builder/LineItemList.jsx';
import TotalsRail from '../components/quote-builder/TotalsRail.jsx';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import QuickActions from '../components/quote-builder/QuickActions.jsx';
import { useUndoToast } from '../components/quote-builder/UndoToast.jsx';

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
    orderId: null,
    status: 'draft',
    currencyCode: 'USD',
    rates: settings?.currencyRates || { USD: 1 },
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
  const { settings, profileId } = useApp();
  const dbQuote = useLiveQuery(() => db.quotes.get(quoteId), [quoteId], null);
  const baseQuote = dbQuote || draftQuote || null;
  // Overlay LIVE exchange rates from Settings onto the quote we hand
  // down to children (totals rail, line items, client preview, PDF
  // export). Without this overlay, the editor renders the rates that
  // were snapshotted at draft time and ignores manual rate changes
  // made afterwards in Settings — the bug the dealer was hitting
  // when typing a custom rate and seeing the quote pane keep the
  // old one.
  //
  // Side effect: updateQuote spreads `{ ...quote, ...patch }` into
  // the DB, so saving the quote also bakes in the current rates.
  // That's intentional — once the dealer touches the quote with new
  // rates in view, those rates ARE the deal they're presenting.
  const quote = useMemo(() => {
    if (!baseQuote) return null;
    return { ...baseQuote, rates: effectiveRates(settings) };
  }, [baseQuote, settings]);
  const lines = useLiveQuery(
    () => db.quoteLines.where('quoteId').equals(quoteId).sortBy('sortOrder'),
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

  const ensurePersisted = useCallback(async () => {
    if (materialize) await materialize();
  }, [materialize]);

  // -------- view + panel state --------
  // The "lista de precios" PDF panel (a `pdfjs-dist` viewer that slid
  // in from the right with the LR price list) was removed entirely —
  // including the upload affordance in Settings, the panel toggle in
  // the header, and the pdfjs-dist dependency itself. The quote
  // builder now stays focused on quote construction; price-list lookup
  // happens outside the app.
  const [view, setView] = useState('compose'); // 'compose' | 'client'
  const [paletteOpen, setPaletteOpen] = useState(false);

  // -------- save indicator state --------
  // We track a UI-only timestamp here rather than reading quote.updatedAt
  // because line edits don't bump the parent quote's updatedAt (by design).
  const [savedAt, setSavedAt] = useState(quote?.updatedAt || null);
  const [saving, setSaving] = useState(false);
  // PDF export UI state — disables the export button while a generation
  // is in flight, and surfaces failures (a malformed line, a refusal
  // from the browser to deliver the blob) instead of swallowing them.
  // Earlier the whole exportPdf() ran without try/catch, so any error
  // — including "nothing happened" — was invisible to the dealer.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  // Counter of in-flight writes so concurrent edits don't flicker the badge.
  const inFlight = useRef(0);

  function markSaving() { inFlight.current += 1; setSaving(true); }
  function markSaved() {
    inFlight.current = Math.max(0, inFlight.current - 1);
    if (inFlight.current === 0) {
      setSaving(false);
      setSavedAt(Date.now());
    }
  }

  // -------- focus for the newest line --------
  const [focusLineId, setFocusLineId] = useState(null);

  // -------- undo toast --------
  const { show: showUndo, element: undoToast } = useUndoToast();

  /* ---------------------------- shortcuts ----------------------------
   * Kept deliberately small to avoid clashing with the browser:
   *   ⌘K       — open the command palette (the universal launcher)
   *   ⌘↵       — add a new blank line (works even inside an input)
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
  useKeyboardShortcut('mod+enter', () => addLine(), { ignoreInInput: false });
  useKeyboardShortcut('mod+p', () => exportPdf(), { ignoreInInput: false });

  if (!quote) return <div className="text-sm text-ink-500">Cargando…</div>;

  /* ---------------------------- mutations ---------------------------- */

  async function updateQuote(patch) {
    markSaving();
    try {
      await ensurePersisted();
      await db.quotes.put({ ...quote, ...patch, updatedAt: Date.now() });
    } finally {
      markSaved();
    }
  }

  function nextSortOrder() {
    return lines.length ? Math.max(...lines.map((l) => l.sortOrder || 0)) + 1 : 0;
  }

  async function addLine(seed = {}) {
    markSaving();
    try {
      await ensurePersisted();
      const id = newId();
      await db.quoteLines.put({
        id,
        quoteId,
        kind: LINE_KIND_ITEM,
        sortOrder: nextSortOrder(),
        family: seed.family || '',
        reference: seed.reference || '',
        name: seed.name || '',
        subtype: seed.subtype || '',
        dimensions: seed.dimensions || '',
        description: seed.description || '',
        pageRef: seed.pageRef || '',
        imageId: seed.imageId || null,
        qty: seed.qty ?? 1,
        unitPrice: seed.unitPrice ?? 0,
        lineMarginPct: seed.lineMarginPct ?? 0,
        lineDiscountPct: seed.lineDiscountPct ?? 0,
        notes: seed.notes || '',
        components: Array.isArray(seed.components) ? seed.components : [],
      });
      setFocusLineId(id);
    } finally {
      markSaved();
    }
  }

  async function addSection() {
    markSaving();
    try {
      await ensurePersisted();
      const id = newId();
      await db.quoteLines.put({
        id,
        quoteId,
        kind: LINE_KIND_SECTION,
        sortOrder: nextSortOrder(),
        family: '',
        reference: '',
        name: '',
        subtype: '',
        dimensions: '',
        description: '',
        pageRef: '',
        imageId: null,
        qty: 0,
        unitPrice: 0,
        lineMarginPct: 0,
        lineDiscountPct: 0,
        notes: '',
        components: [],
      });
      setFocusLineId(id);
    } finally {
      markSaved();
    }
  }

  async function updateLine(id, patch) {
    markSaving();
    try { await db.quoteLines.update(id, patch); }
    finally { markSaved(); }
  }

  async function duplicateLine(line) {
    markSaving();
    try {
      await ensurePersisted();
      const id = newId();
      // Insert immediately after the source line. We renumber everything
      // after the insertion point so the new line lands exactly where the
      // user expects.
      const srcIdx = lines.findIndex((l) => l.id === line.id);
      const newSortOrder = (line.sortOrder ?? 0) + 1;
      // Deep-copy compound components and stamp fresh ids on each so
      // React keys (and any future direct-component reference) don't
      // collide between the original and the duplicate.
      const components = Array.isArray(line.components)
        ? line.components.map((c) => ({ ...c, id: newId() }))
        : [];
      await db.quoteLines.put({
        ...line,
        id,
        sortOrder: newSortOrder,
        components,
      });
      // Bump everyone after.
      const after = lines.slice(srcIdx + 1);
      for (const l of after) {
        await db.quoteLines.update(l.id, { sortOrder: (l.sortOrder ?? 0) + 1 });
      }
      setFocusLineId(id);
    } finally {
      markSaved();
    }
  }

  /**
   * Toggle the line's `isOptional` flag. Optional lines render with
   * a badge in the editor + client preview but isPricedLine excludes
   * them from totals, so the total adjusts in one round-trip without
   * any extra recompute on this side.
   *
   * Defensive: if the line is currently part of an alternative group
   * we strip the alternative metadata at the same time — optional +
   * alternative is forbidden by the DB CHECK and would otherwise
   * surface a 23514 error on the next sync.
   */
  async function toggleOptional(line) {
    markSaving();
    try {
      const next = !line.isOptional;
      const patch = next
        ? { isOptional: true, alternativeGroup: null, isSelectedAlternative: false }
        : { isOptional: false };
      await db.quoteLines.update(line.id, patch);
    } finally {
      markSaved();
    }
  }

  /**
   * Clone the line into a new (or existing) alternative group.
   *
   *   - If the source line is standalone, mint a group id, mark the
   *     source as the SELECTED alternative, and insert the duplicate
   *     immediately after it as a non-selected sibling.
   *   - If the source already lives in a group, just insert another
   *     non-selected sibling at the end of the group's run.
   *
   * Same sortOrder-bump pattern as duplicateLine so the new row
   * lands adjacent to its siblings.
   */
  async function addAlternative(line) {
    if (line.isOptional) return;  // mutually exclusive — UI hides this option anyway
    markSaving();
    try {
      await ensurePersisted();
      const groupId = line.alternativeGroup || newId();
      // If this is the FIRST alternative being created on a previously-
      // standalone line, mark the source as the selected one.
      if (!line.alternativeGroup) {
        await db.quoteLines.update(line.id, {
          alternativeGroup: groupId,
          isSelectedAlternative: true,
        });
      }
      // Insert position: directly after the last member of this group
      // currently in the lines list. Keeps siblings contiguous.
      const groupMembers = lines.filter((l) => l.alternativeGroup === groupId || l.id === line.id);
      const lastIdx = Math.max(...groupMembers.map((l) => lines.findIndex((x) => x.id === l.id)));
      const newSortOrder = (lines[lastIdx]?.sortOrder ?? line.sortOrder ?? 0) + 1;
      const newId_ = newId();
      const components = Array.isArray(line.components)
        ? line.components.map((c) => ({ ...c, id: newId() }))
        : [];
      await db.quoteLines.put({
        ...line,
        id: newId_,
        sortOrder: newSortOrder,
        alternativeGroup: groupId,
        isSelectedAlternative: false,
        components,
      });
      // Bump everyone after the insertion point to keep ordering tight.
      for (const l of lines.slice(lastIdx + 1)) {
        await db.quoteLines.update(l.id, { sortOrder: (l.sortOrder ?? 0) + 1 });
      }
      setFocusLineId(newId_);
    } finally {
      markSaved();
    }
  }

  /**
   * Within an alternative group, flip exactly one line to selected.
   * Sets `isSelectedAlternative=true` on the picked line and false on
   * its siblings — the invariant is enforced by this writer; the DB
   * happily allows 0 or N selected sibs at rest, but isPricedLine
   * would then silently count 0 or N priced lines, which is wrong.
   */
  async function selectAlternative(line) {
    if (!line.alternativeGroup) return;
    markSaving();
    try {
      const siblings = lines.filter((l) => l.alternativeGroup === line.alternativeGroup);
      for (const s of siblings) {
        const shouldBeSelected = s.id === line.id;
        if (!!s.isSelectedAlternative !== shouldBeSelected) {
          await db.quoteLines.update(s.id, { isSelectedAlternative: shouldBeSelected });
        }
      }
    } finally {
      markSaved();
    }
  }

  async function removeLine(line) {
    markSaving();
    try {
      await db.quoteLines.delete(line.id);
      // If we just deleted the SELECTED alternative in a group, promote
      // the next sibling to selected so the group still contributes
      // exactly one priced line to the total. Otherwise the group
      // would silently drop out of the math.
      if (line.alternativeGroup && line.isSelectedAlternative) {
        const siblings = lines.filter(
          (l) => l.alternativeGroup === line.alternativeGroup && l.id !== line.id,
        );
        if (siblings.length > 0) {
          await db.quoteLines.update(siblings[0].id, { isSelectedAlternative: true });
        }
      }
      const label = line.kind === LINE_KIND_SECTION
        ? `Sección "${line.name || 'sin nombre'}" eliminada`
        : `Artículo "${line.name || line.reference || 'sin nombre'}" eliminado`;
      showUndo(label, async () => {
        // Restore the row at its original sort_order. The other rows kept
        // their positions, so the slot is still empty.
        await db.quoteLines.put(line);
      });
    } finally {
      markSaved();
    }
  }

  async function reorderLines(orderedIds) {
    markSaving();
    try {
      const idToLine = new Map(lines.map((l) => [l.id, l]));
      for (let i = 0; i < orderedIds.length; i++) {
        const l = idToLine.get(orderedIds[i]);
        if (!l) continue;
        if (l.sortOrder !== i) await db.quoteLines.update(l.id, { sortOrder: i });
      }
    } finally {
      markSaved();
    }
  }

  const totals = computeTotals(
    lines.filter(isPricedLine).map(lineForTotals),
    { marginPct: quote.marginPct, discountPct: quote.discountPct, shipping: quote.shipping },
  );

  async function exportPdf() {
    if (exporting) return;          // de-bounce double-taps
    setExportError(null);
    setExporting(true);
    try {
      const customer = quote.customerId
        ? customers.find((c) => c.id === quote.customerId)
        : null;
      const { generateQuotePdf, downloadBlob } = await safeDynamicImport(
        () => import('../pdf/quotePdf.js'),
      );
      // Pass *all* lines to the generator — including section breaks.
      // The generator's groupBySection() consumes them as headings; the
      // earlier filter that stripped sections out predates the PDF
      // matching the on-screen ClientPreview, where section headers
      // ("MOBILIARIO DE SALA") are part of the layout the customer
      // sees in both places.
      const blob = await generateQuotePdf({ quote, settings, lines, totals, customer });
      // downloadBlob is async now: it awaits navigator.share on mobile/
      // PWA. The await here is what made the iOS-PWA "nothing happens"
      // bug surface — without awaiting we'd never see the share-sheet
      // rejection that the platform raised silently.
      await downloadBlob(blob, `Cotizacion-${quote.number || 'borrador'}.pdf`);
    } catch (err) {
      console.error('[QuoteBuilder] exportPdf failed:', err);
      setExportError(err?.message || 'No se pudo generar el PDF.');
    } finally {
      setExporting(false);
    }
  }

  /* ---------------------------- render ---------------------------- */

  const customer = quote.customerId ? customers.find((c) => c.id === quote.customerId) : null;

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
        onExportPdf={exportPdf}
        onUpdateQuote={updateQuote}
        savedAt={savedAt}
        saving={saving}
        exporting={exporting}
      />

      {/* Surface PDF export failures inline. The export button used to
          fail silently in iOS-PWA standalone — now if anything throws
          (gesture timed out, share sheet rejected, generator crashed),
          the dealer sees a dismissible banner with the underlying
          message instead of just "I tapped it and nothing happened". */}
      {exportError && (
        <div role="alert" className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800 flex items-start gap-2">
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

      <div className="mb-5">
        <QuoteStatusStepper quote={quote} onTransition={updateQuote} />
      </div>

      {view === 'client' ? (
        <ClientPreview
          quote={quote}
          settings={settings}
          lines={lines}
          totals={totals}
          customer={customer}
        />
      ) : (
        // Left column uses `minmax(0, 1fr)` — not bare `1fr` — so it can
        // shrink below its content's intrinsic min-width. Without that,
        // the implicit `min-width: auto` on a 1fr track stops the column
        // from accepting `min-width: 0` from descendants, and any long
        // string (a 6-digit money value, a full dimension spec) forces
        // the whole column wider than the viewport.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5 min-w-0">
            <LineItemsCard
              lines={lines}
              quote={quote}
              focusLineId={focusLineId}
              onChangeLine={updateLine}
              onRemoveLine={removeLine}
              onDuplicateLine={duplicateLine}
              onToggleOptional={toggleOptional}
              onAddAlternative={addAlternative}
              onSelectAlternative={selectAlternative}
              onReorder={reorderLines}
              onAddItem={() => addLine()}
              onAddSection={addSection}
            />
            <NotesAndTermsCard quote={quote} onUpdateQuote={updateQuote} />
          </div>

          {/* Right column: totals rail, sticky on desktop. The price-list
              PDF panel that used to alternate into this slot is gone. */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <TotalsRail quote={quote} totals={totals} onUpdateQuote={updateQuote} />
          </div>
        </div>
      )}

      {/* Mobile sticky totals bar */}
      <MobileStickyTotals
        quote={quote}
        totals={totals}
        onAdd={() => addLine()}
        onExport={exportPdf}
        exporting={exporting}
      />

      <QuickActions
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        customers={customers}
        currentCustomerId={quote.customerId}
        onInsertLine={(seed) => addLine(seed)}
        onAddSection={addSection}
        onSelectCustomer={(id) => updateQuote({ customerId: id })}
        onExportPdf={exportPdf}
        onToggleClientView={() => setView((v) => v === 'compose' ? 'client' : 'compose')}
        clientView={view === 'client'}
        currency={quote.currencyCode || 'USD'}
        rates={quote.rates || { USD: 1 }}
      />

      {undoToast}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sub-cards                                                                  */
/* -------------------------------------------------------------------------- */

function LineItemsCard({
  lines, quote, focusLineId,
  onChangeLine, onRemoveLine, onDuplicateLine, onReorder,
  onToggleOptional, onAddAlternative, onSelectAlternative,
  onAddItem, onAddSection,
}) {
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
          <button
            type="button"
            onClick={onAddItem}
            className="btn-secondary"
            title={`Agregar artículo (${shortcutLabel('mod+enter')})`}
          >
            <Plus size={14} /> Agregar
          </button>
        </div>
      </header>
      <LineItemList
        lines={lines}
        quote={quote}
        focusLineId={focusLineId}
        onChangeLine={onChangeLine}
        onRemoveLine={onRemoveLine}
        onDuplicateLine={onDuplicateLine}
        onToggleOptional={onToggleOptional}
        onAddAlternative={onAddAlternative}
        onSelectAlternative={onSelectAlternative}
        onReorder={onReorder}
        onAddItem={onAddItem}
        onAddSection={onAddSection}
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
            <button type="button" onClick={onAddItem} className="btn-secondary text-xs">
              <Plus size={12} /> Agregar otro
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

/**
 * Tight totals strip shown above the line items only when the PDF panel
 * is open and the rail is hidden. Keeps the running total in view without
 * eating vertical space.
 */
function MobileStickyTotals({ quote, totals, onAdd, onExport, exporting }) {
  // Bottom-anchored action bar. We pad pl/pr with the landscape safe-area
  // insets so the buttons clear the Dynamic Island ear when the phone is
  // sideways; pb uses max(0.75rem, …) so the home indicator never overlaps
  // the buttons. The spacer below reserves room so the page content can
  // scroll fully into view without the bar covering the last row.
  return (
    <>
      <div
        className="md:hidden fixed inset-x-0 bottom-0 z-20 bg-white border-t border-ink-200 shadow-[0_-2px_8px_rgba(0,0,0,0.05)] py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center gap-2"
      >
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Total</div>
          <div className="text-lg font-semibold tabular-nums truncate">
            {formatMoney(totals.grandTotal, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}
          </div>
        </div>
        <button type="button" onClick={onAdd} className="btn-secondary" aria-label="Agregar artículo">
          <Plus size={16} /> <span>Artículo</span>
        </button>
        {/* On mobile, this button is the *only* way to export — the
            desktop header version is hidden. Disable it while a
            generation is in flight so a frustrated dealer double-tap
            doesn't fire two share sheets in a row. The Loader2 spinner
            gives an unambiguous "I heard you, working on it" signal,
            which the previous silent button didn't. */}
        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className="btn-primary disabled:opacity-60 disabled:cursor-wait"
          aria-label="Exportar PDF"
        >
          {exporting
            ? <><Loader2 size={16} className="animate-spin" /> PDF</>
            : <><Download size={16} /> PDF</>}
        </button>
      </div>
      {/* Spacer matches the bar height + safe-area so the last list row is
          fully scrollable above the bar. */}
      <div
        className="md:hidden h-[calc(4.5rem+env(safe-area-inset-bottom))]"
        aria-hidden
      />
    </>
  );
}
