import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Hash, Download } from 'lucide-react';
import { useLiveQuery } from '../db/hooks.js';
import PdfViewer from '../components/PdfViewer.jsx';
import { db, newId } from '../db/database.js';
import { publicPricelistUrl } from '../db/supabaseClient.js';
import { useApp } from '../context/AppContext.jsx';
import { computeTotals } from '../lib/pricing.js';
import { formatMoney } from '../lib/format.js';
import { generateQuotePdf, downloadBlob } from '../pdf/quotePdf.js';
import { useKeyboardShortcut, shortcutLabel } from '../lib/useKeyboardShortcut.js';
import { DebouncedTextarea } from '../components/DebouncedInput.jsx';

import QuoteHeader from '../components/quote-builder/QuoteHeader.jsx';
import QuoteStatusStepper from '../components/quote-builder/QuoteStatusStepper.jsx';
import LineItemList from '../components/quote-builder/LineItemList.jsx';
import TotalsRail from '../components/quote-builder/TotalsRail.jsx';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import QuickActions from '../components/quote-builder/QuickActions.jsx';
import { useUndoToast } from '../components/quote-builder/UndoToast.jsx';

// Sticky per-user (not per-quote): remember whether the PDF panel was open.
const PDF_PANEL_STORAGE_KEY = 'rosetsoft.pdfPanel.open';

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
  const { profileId, settings } = useApp();
  const { quoteId: routeId } = useParams();
  const [search] = useSearchParams();

  if (routeId) return <Workspace quoteId={routeId} navigate={navigate} />;

  return (
    <DraftWorkspace
      profileId={profileId}
      settings={settings}
      initialRef={search.get('ref') || ''}
      navigate={navigate}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Draft → Materialize                                                       */
/* -------------------------------------------------------------------------- */

function DraftWorkspace({ profileId, settings, initialRef, navigate }) {
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = newId();
  const id = idRef.current;

  const defaults = useMemo(() => ({
    id,
    profileId,
    number: null,
    name: '',
    customerId: null,
    containerId: settings?.defaultContainerId || null,
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
  }), [id, profileId, settings]);

  const persistedRef = useRef(false);
  const inFlightRef = useRef(null);

  const materialize = useCallback(async () => {
    if (persistedRef.current) return id;
    if (inFlightRef.current) return inFlightRef.current;
    inFlightRef.current = (async () => {
      try {
        const number = (settings?.quoteCounter || 1000) + 1;
        await db.quotes.put({ ...defaults, number, updatedAt: Date.now() });
        await db.settings.put({ ...(settings || { profileId }), profileId, quoteCounter: number });
        persistedRef.current = true;
        try { window.history.replaceState(null, '', `#/quotes/${id}`); } catch {}
        return id;
      } catch (e) {
        inFlightRef.current = null;
        throw e;
      }
    })();
    return inFlightRef.current;
  }, [id, defaults, profileId, settings]);

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
        kind: 'item',
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
  const liveQuote = useLiveQuery(() => db.quotes.get(quoteId), [quoteId], null);
  const quote = liveQuote || draftQuote || null;
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

  const ensurePersisted = useCallback(async () => {
    if (materialize) await materialize();
  }, [materialize]);

  // -------- view + panels state --------
  const [view, setView] = useState('compose'); // 'compose' | 'client'
  const priceListUrl = useMemo(
    () => publicPricelistUrl(settings?.priceList?.path),
    [settings?.priceList?.path],
  );
  const hasPdf = !!priceListUrl;
  const [pdfOpen, setPdfOpen] = useState(() => {
    try { return localStorage.getItem(PDF_PANEL_STORAGE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(PDF_PANEL_STORAGE_KEY, pdfOpen ? '1' : '0'); } catch {}
  }, [pdfOpen]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // -------- save indicator state --------
  // We track a UI-only timestamp here rather than reading quote.updatedAt
  // because line edits don't bump the parent quote's updatedAt (by design).
  const [savedAt, setSavedAt] = useState(quote?.updatedAt || null);
  const [saving, setSaving] = useState(false);
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
        kind: 'item',
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
        kind: 'section',
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
      await db.quoteLines.put({
        ...line,
        id,
        sortOrder: newSortOrder,
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

  async function removeLine(line) {
    markSaving();
    try {
      await db.quoteLines.delete(line.id);
      const label = line.kind === 'section'
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
    lines
      .filter((l) => l.kind !== 'section')
      .map((l) => ({
        qty: l.qty,
        basePrice: l.unitPrice,
        lineMarginPct: l.lineMarginPct,
        lineDiscountPct: l.lineDiscountPct,
      })),
    { marginPct: quote.marginPct, discountPct: quote.discountPct, shipping: quote.shipping },
  );

  async function exportPdf() {
    const customer = quote.customerId ? customers.find((c) => c.id === quote.customerId) : null;
    // The PDF generator predates sections — strip them out so the printable
    // is a clean item list (sections are visible in the on-screen client
    // preview but not yet in the printed PDF).
    const printable = lines.filter((l) => l.kind !== 'section');
    const blob = await generateQuotePdf({ quote, settings, lines: printable, totals, customer });
    downloadBlob(blob, `Quote-${quote.number || 'draft'}.pdf`);
  }

  /* ---------------------------- render ---------------------------- */

  const customer = quote.customerId ? customers.find((c) => c.id === quote.customerId) : null;

  return (
    <>
      <QuoteHeader
        quote={quote}
        customers={customers}
        profileId={profileId}
        view={view}
        onViewChange={setView}
        pdfOpen={pdfOpen}
        onTogglePdf={() => setPdfOpen((v) => !v)}
        hasPdf={hasPdf}
        onOpenPalette={() => setPaletteOpen(true)}
        onExportPdf={exportPdf}
        onUpdateQuote={updateQuote}
        savedAt={savedAt}
        saving={saving}
      />

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
        <div className={`grid grid-cols-1 gap-6 ${pdfOpen ? 'lg:grid-cols-[1fr_520px]' : 'lg:grid-cols-[1fr_360px]'}`}>
          {/* Main column */}
          <div className={`space-y-5 min-w-0 ${pdfOpen ? '' : ''}`}>
            <LineItemsCard
              lines={lines}
              quote={quote}
              focusLineId={focusLineId}
              onChangeLine={updateLine}
              onRemoveLine={removeLine}
              onDuplicateLine={duplicateLine}
              onReorder={reorderLines}
              onAddItem={() => addLine()}
              onAddSection={addSection}
            />

            {/* When the PDF panel is on, totals collapse here so the running
                total stays visible while the dealer reads the price-list. */}
            {pdfOpen && (
              <div className="lg:hidden">
                <TotalsRail quote={quote} totals={totals} onUpdateQuote={updateQuote} />
              </div>
            )}
            {pdfOpen && (
              <div className="hidden lg:block">
                <CompactTotals quote={quote} totals={totals} />
                <div className="mt-5">
                  <TotalsRail quote={quote} totals={totals} onUpdateQuote={updateQuote} />
                </div>
              </div>
            )}

            <NotesAndTermsCard quote={quote} onUpdateQuote={updateQuote} />
          </div>

          {/* Right column: either the PDF or the totals rail */}
          {pdfOpen ? (
            <div className="hidden lg:block lg:sticky lg:top-4 lg:self-start h-[calc(100vh-2rem)] card overflow-hidden">
              <PdfViewer url={priceListUrl} />
            </div>
          ) : (
            <div className="lg:sticky lg:top-4 lg:self-start">
              <TotalsRail quote={quote} totals={totals} onUpdateQuote={updateQuote} />
            </div>
          )}
        </div>
      )}

      {/* Mobile sticky totals bar */}
      <MobileStickyTotals
        quote={quote}
        totals={totals}
        onAdd={() => addLine()}
        onExport={exportPdf}
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
        onTogglePdfPanel={() => setPdfOpen((v) => !v)}
        hasPdfPanel={hasPdf}
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
  onAddItem, onAddSection,
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-ink-100 flex items-center justify-between gap-3">
        <h2 className="font-semibold">Artículos</h2>
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
      </div>
      <LineItemList
        lines={lines}
        quote={quote}
        focusLineId={focusLineId}
        onChangeLine={onChangeLine}
        onRemoveLine={onRemoveLine}
        onDuplicateLine={onDuplicateLine}
        onReorder={onReorder}
        onAddItem={onAddItem}
        onAddSection={onAddSection}
      />
      {lines.length > 0 && (
        <div className="px-5 py-3 border-t border-ink-100 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-500">
            {lines.filter((l) => l.kind !== 'section').length} artículo(s) · arrastra
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
function CompactTotals({ quote, totals }) {
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  return (
    <div className="card px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-4 text-xs text-ink-500 tabular-nums">
        <span>Subtotal <b className="text-ink-900">{formatMoney(totals.subtotal, currency, rates)}</b></span>
        {quote.discountPct ? <span>Desc. <b className="text-ink-900">–{quote.discountPct}%</b></span> : null}
        <span>ITBIS <b className="text-ink-900">{formatMoney(totals.taxAmt, currency, rates)}</b></span>
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-wide text-ink-500">Total</div>
        <div className="text-lg font-semibold tabular-nums">{formatMoney(totals.grandTotal, currency, rates)}</div>
      </div>
    </div>
  );
}

function MobileStickyTotals({ quote, totals, onAdd, onExport }) {
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
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Total</div>
          <div className="text-lg font-semibold tabular-nums truncate">
            {formatMoney(totals.grandTotal, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}
          </div>
        </div>
        <button type="button" onClick={onAdd} className="btn-secondary" aria-label="Agregar artículo">
          <Plus size={16} /> <span>Artículo</span>
        </button>
        <button type="button" onClick={onExport} className="btn-primary" aria-label="Exportar PDF">
          <Download size={16} /> PDF
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
