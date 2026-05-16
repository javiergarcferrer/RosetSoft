import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { Plus, Download, ArrowLeft, BookOpen, X } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { DebouncedInput, DebouncedTextarea } from '../components/DebouncedInput.jsx';
import QuoteLineRow from '../components/quote-builder/QuoteLineRow.jsx';
import QuoteLineCard from '../components/quote-builder/QuoteLineCard.jsx';
import PdfViewer from '../components/PdfViewer.jsx';
import { db, newId } from '../db/database.js';
import { publicPricelistUrl } from '../db/supabaseClient.js';
import { useApp } from '../context/AppContext.jsx';
import { computeTotals, clampPct, ITBIS_PCT } from '../lib/pricing.js';
import { formatMoney, formatDateTime } from '../lib/format.js';
import { generateQuotePdf, downloadBlob } from '../pdf/quotePdf.js';

// Sticky-per-user (NOT per-quote) preference: was the PDF panel open last time?
const PDF_PANEL_STORAGE_KEY = 'rosetsoft.pdfPanel.open';

/**
 * Quote builder.
 *
 * Lines are free-form: the user reads a row from the price-list PDF and
 * types it in directly — there is no normalized catalog the line refers
 * back to. Each line stores its own copy of family / reference / name /
 * subtype / dimensions / image / unit price so the quote remains
 * self-contained even if the price list changes in the next edition.
 */
export default function QuoteBuilder() {
  const navigate = useNavigate();
  const { profileId, settings } = useApp();
  const { quoteId: routeId } = useParams();
  const [search] = useSearchParams();

  if (routeId) return <Builder quoteId={routeId} navigate={navigate} />;

  return (
    <DraftBuilder
      profileId={profileId}
      settings={settings}
      initialRef={search.get('ref') || ''}
      navigate={navigate}
    />
  );
}

function DraftBuilder({ profileId, settings, initialRef, navigate }) {
  // Stable id chosen up-front; the row only exists in Supabase after materialize.
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = newId();
  const id = idRef.current;

  const defaults = useMemo(() => ({
    id,
    profileId,
    number: null,
    name: '',
    customerId: null,
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

  // Persist on first real action. Cached in a ref so concurrent mutations
  // share the single in-flight create instead of double-writing the row.
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

  // ?ref=XXXXX — pre-fill the first line's reference field after materialize.
  useEffect(() => {
    if (!initialRef) return;
    let cancel = false;
    (async () => {
      await materialize();
      if (cancel) return;
      await db.quoteLines.put({
        id: newId(),
        quoteId: id,
        sortOrder: 0,
        family: '',
        reference: initialRef,
        name: '',
        subtype: '',
        dimensions: '',
        description: '',
        yardage: '',
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
    <Builder
      quoteId={id}
      navigate={navigate}
      draftQuote={defaults}
      materialize={materialize}
    />
  );
}

function Builder({ quoteId, navigate, draftQuote, materialize }) {
  const { settings, profileId } = useApp();
  const liveQuote = useLiveQuery(() => db.quotes.get(quoteId), [quoteId], null);
  const quote = liveQuote || draftQuote || null;
  const lines = useLiveQuery(
    () => db.quoteLines.where('quoteId').equals(quoteId).sortBy('sortOrder'),
    [quoteId],
    []
  );

  const ensurePersisted = useCallback(async () => {
    if (materialize) await materialize();
  }, [materialize]);
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    []
  );

  // Side-panel PDF viewer state. Default off on first ever load; once toggled
  // we remember the choice across sessions/quotes via localStorage.
  const priceListUrl = useMemo(
    () => publicPricelistUrl(settings?.priceList?.path),
    [settings?.priceList?.path],
  );
  const [pdfOpen, setPdfOpen] = useState(() => {
    try { return localStorage.getItem(PDF_PANEL_STORAGE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(PDF_PANEL_STORAGE_KEY, pdfOpen ? '1' : '0'); } catch {}
  }, [pdfOpen]);

  // When `addLine` runs we stash the new id here so the matching row can
  // auto-focus its reference input on mount. One-shot — cleared after consumption.
  const [focusLineId, setFocusLineId] = useState(null);

  if (!quote) return <div className="text-sm text-ink-500">Cargando…</div>;

  async function updateQuote(patch) {
    await ensurePersisted();
    await db.quotes.put({ ...quote, ...patch, updatedAt: Date.now() });
  }

  async function addLine() {
    await ensurePersisted();
    const id = newId();
    await db.quoteLines.put({
      id,
      quoteId,
      sortOrder: lines.length,
      family: '',
      reference: '',
      name: '',
      subtype: '',
      dimensions: '',
      description: '',
      yardage: '',
      pageRef: '',
      imageId: null,
      qty: 1,
      unitPrice: 0,
      lineMarginPct: 0,
      lineDiscountPct: 0,
      notes: '',
    });
    setFocusLineId(id);
  }

  async function updateLine(id, patch) {
    await db.quoteLines.update(id, patch);
  }

  async function removeLine(id) {
    await db.quoteLines.delete(id);
  }

  const totals = computeTotals(
    lines.map((l) => ({
      qty: l.qty,
      basePrice: l.unitPrice,
      lineMarginPct: l.lineMarginPct,
      lineDiscountPct: l.lineDiscountPct,
    })),
    { marginPct: quote.marginPct, discountPct: quote.discountPct, shipping: quote.shipping }
  );

  async function exportPdf() {
    const customer = quote.customerId ? customers.find((c) => c.id === quote.customerId) : null;
    const blob = await generateQuotePdf({ quote, settings, lines, totals, customer });
    downloadBlob(blob, `Quote-${quote.number || 'draft'}.pdf`);
  }

  return (
    <>
      <Link to="/quotes" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 mb-3">
        <ArrowLeft size={12} /> Volver a cotizaciones
      </Link>
      <PageHeader
        title={quote.number ? `Cotización #${quote.number}` : 'Cotización (borrador)'}
        subtitle={`Actualizada ${formatDateTime(quote.updatedAt)}`}
        actions={
          <>
            <button
              onClick={() => setPdfOpen((v) => !v)}
              className={`btn-ghost hidden lg:inline-flex ${pdfOpen ? 'bg-ink-100' : ''}`}
              title={pdfOpen ? 'Ocultar lista de precios' : 'Mostrar lista de precios'}
            >
              {pdfOpen ? <><X size={14} /> Ocultar PDF</> : <><BookOpen size={14} /> Lista de precios</>}
            </button>
            <select
              value={quote.status || 'draft'}
              onChange={(e) => updateQuote({ status: e.target.value })}
              className="input max-w-[140px]"
            >
              <option value="draft">Borrador</option>
              <option value="sent">Enviada</option>
              <option value="accepted">Aceptada</option>
              <option value="declined">Rechazada</option>
              <option value="archived">Archivada</option>
            </select>
            <button onClick={exportPdf} className="btn-primary hidden md:inline-flex"><Download size={14} /> Exportar PDF</button>
          </>
        }
      />

      <div className={`grid grid-cols-1 gap-6 ${pdfOpen ? 'lg:grid-cols-[1fr_520px]' : 'lg:grid-cols-3'}`}>
        <div className={pdfOpen ? 'space-y-4 min-w-0' : 'lg:col-span-2 space-y-4'}>
          {/* Quote header */}
          <div className="card card-pad space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="label">Nombre interno</div>
                <DebouncedInput className="input" value={quote.name || ''} onCommit={(v) => updateQuote({ name: v })} placeholder='p. ej. "Residencia Smith — sala"' />
              </div>
              <div>
                <div className="label">Cliente</div>
                <select className="input" value={quote.customerId || ''} onChange={(e) => updateQuote({ customerId: e.target.value || null })}>
                  <option value="">— Sin cliente —</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
              <h2 className="font-semibold">Artículos</h2>
              <button onClick={addLine} className="btn-secondary">
                <Plus size={14} /> Agregar artículo
              </button>
            </div>
            {lines.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-ink-500">
                Sin artículos — toca <b>Agregar artículo</b> para empezar.
              </div>
            ) : (
              <>
                {/* Mobile: stacked cards */}
                <ul className="md:hidden divide-y divide-ink-100">
                  {lines.map((l) => (
                    <QuoteLineCard
                      key={l.id}
                      line={l}
                      quote={quote}
                      autoFocus={l.id === focusLineId}
                      onChange={(patch) => updateLine(l.id, patch)}
                      onRemove={() => removeLine(l.id)}
                    />
                  ))}
                </ul>

                {/* Desktop: table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="table min-w-[760px]">
                    <thead>
                      <tr>
                        <th className="w-20">Foto</th>
                        <th>Artículo</th>
                        <th className="w-28">Referencia</th>
                        <th className="w-20 text-right">Cant.</th>
                        <th className="w-32 text-right">Unit.</th>
                        <th className="w-32 text-right">Total</th>
                        <th className="w-16" />
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <QuoteLineRow
                          key={l.id}
                          line={l}
                          quote={quote}
                          autoFocus={l.id === focusLineId}
                          onChange={(patch) => updateLine(l.id, patch)}
                          onRemove={() => removeLine(l.id)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Repeat-add button at the bottom so the user can keep
                    transcribing PDF rows without scrolling back to the top. */}
                <div className="px-5 py-3 border-t border-ink-100 flex justify-end">
                  <button onClick={addLine} className="btn-secondary text-xs">
                    <Plus size={12} /> Agregar otra línea
                  </button>
                </div>
              </>
            )}
          </div>

          {/* When the PDF panel is open the right column belongs to the PDF;
              the totals + notes drop here under the line items so they stay
              reachable without alt-tabbing. */}
          {pdfOpen && <SidebarBlock quote={quote} totals={totals} updateQuote={updateQuote} />}
        </div>

        {pdfOpen ? (
          <div className="hidden lg:block lg:sticky lg:top-4 lg:self-start h-[calc(100vh-2rem)] card overflow-hidden">
            <PdfViewer url={priceListUrl} />
          </div>
        ) : (
          <SidebarBlock quote={quote} totals={totals} updateQuote={updateQuote} />
        )}
      </div>

      {/* Mobile sticky totals bar */}
      <div
        className="md:hidden fixed inset-x-0 bottom-0 z-20 bg-white border-t border-ink-200 shadow-[0_-2px_8px_rgba(0,0,0,0.05)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center gap-3"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Total</div>
          <div className="text-lg font-semibold tabular-nums truncate">
            {formatMoney(totals.grandTotal, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}
          </div>
        </div>
        <button onClick={addLine} className="btn-secondary">
          <Plus size={14} /> Artículo
        </button>
        <button onClick={exportPdf} className="btn-primary">
          <Download size={14} /> PDF
        </button>
      </div>
      {/* Spacer so content can scroll above the sticky bar */}
      <div className="md:hidden h-20" aria-hidden />
    </>
  );
}

function SidebarBlock({ quote, totals, updateQuote }) {
  return (
    <div className="space-y-4">
      <div className="card card-pad space-y-3">
        <h2 className="font-semibold text-sm">Totales</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="label">Descuento %</div>
            <DebouncedInput className="input" type="number" min="0" max="100" value={quote.discountPct ?? 0} onCommit={(v) => updateQuote({ discountPct: clampPct(v) })} />
          </div>
          <div>
            <div className="label">Envío (USD)</div>
            <DebouncedInput className="input" type="number" min="0" value={quote.shipping ?? 0} onCommit={(v) => updateQuote({ shipping: Math.max(0, Number(v) || 0) })} />
          </div>
        </div>
        <div className="text-[10px] text-ink-500">
          Precios en USD · ITBIS fijo en {ITBIS_PCT}% · El PDF incluye conversión a DOP usando la <Link to="/settings" className="underline">tasa configurada</Link>.
        </div>
        <hr className="border-ink-100" />
        <Row label="Subtotal" value={totals.subtotal} quote={quote} />
        {quote.discountPct ? <Row label={`Descuento (${quote.discountPct}%)`} value={-totals.discountAmt} quote={quote} muted /> : null}
        <Row label={`ITBIS (${ITBIS_PCT}%)`} value={totals.taxAmt} quote={quote} muted />
        {quote.shipping ? <Row label="Envío" value={totals.shipping} quote={quote} muted /> : null}
        <Row label="Total" value={totals.grandTotal} quote={quote} bold />
      </div>

      <div className="card card-pad space-y-3">
        <h2 className="font-semibold text-sm">Términos y notas</h2>
        <div>
          <div className="label">Notas internas</div>
          <DebouncedTextarea className="input min-h-[80px]" value={quote.notes || ''} onCommit={(v) => updateQuote({ notes: v })} />
        </div>
        <div>
          <div className="label">Términos (se imprimen en el PDF)</div>
          <DebouncedTextarea className="input min-h-[100px]" value={quote.terms || ''} onCommit={(v) => updateQuote({ terms: v })} />
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, quote, bold, muted }) {
  return (
    <div className={`flex items-center justify-between text-sm ${bold ? 'font-semibold text-base mt-1.5 pt-2 border-t border-ink-100' : ''} ${muted ? 'text-ink-500' : ''}`}>
      <span>{label}</span>
      <span>{formatMoney(value, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}</span>
    </div>
  );
}
