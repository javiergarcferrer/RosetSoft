import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { Plus, Download, ArrowLeft } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { DebouncedInput, DebouncedTextarea } from '../components/DebouncedInput.jsx';
import QuoteLineRow from '../components/quote-builder/QuoteLineRow.jsx';
import QuoteLineCard from '../components/quote-builder/QuoteLineCard.jsx';
import ProductPickerModal from '../components/quote-builder/ProductPickerModal.jsx';
import MaterialPickerModal from '../components/quote-builder/MaterialPickerModal.jsx';
import { db, newId } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { computeTotals, applyLineAdjustments, resolveLineBasePrice, clampPct, ITBIS_PCT } from '../lib/pricing.js';
import { formatMoney, formatDateTime } from '../lib/format.js';
import { generateQuotePdf, downloadBlob } from '../pdf/quotePdf.js';

export default function QuoteBuilder() {
  const navigate = useNavigate();
  const { profileId, settings } = useApp();
  const { quoteId: routeId } = useParams();
  const [search] = useSearchParams();

  // Already-saved quote — render normally.
  if (routeId) return <Builder quoteId={routeId} navigate={navigate} />;

  // Otherwise the user just hit /quotes/new. Render the builder against an
  // in-memory draft. Nothing is written to Supabase until the user actually
  // does something (types a name, picks a customer, adds a line item).
  return (
    <DraftBuilder
      profileId={profileId}
      settings={settings}
      initialProductId={search.get('product')}
      navigate={navigate}
    />
  );
}

function DraftBuilder({ profileId, settings, initialProductId, navigate }) {
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
    taxPct: 0,
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
        // Quietly update the URL bar so reload / share lands on the saved
        // quote. Hash-router's listener doesn't fire on replaceState, so
        // React Router stays at /quotes/new and the component does NOT
        // remount — debounced inputs, picker state, scroll position all
        // survive.
        try {
          window.history.replaceState(null, '', `#/quotes/${id}`);
        } catch {}
        return id;
      } catch (e) {
        // Allow a retry on the next user action.
        inFlightRef.current = null;
        throw e;
      }
    })();
    return inFlightRef.current;
  }, [id, defaults, profileId, settings]);

  // ?product=X — adding an initial line IS a real action, so it materializes.
  useEffect(() => {
    if (!initialProductId) return;
    let cancel = false;
    (async () => {
      const variants = await db.productVariants.where('productId').equals(initialProductId).toArray();
      const firstVariant = variants.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))[0];
      if (!firstVariant || cancel) return;
      await materialize();
      if (cancel) return;
      await db.quoteLines.put({
        id: newId(),
        quoteId: id,
        productVariantId: firstVariant.id,
        materialId: null,
        colorId: null,
        qty: 1,
        unitPrice: 0,
        priceOverride: null,
        lineMarginPct: 0,
        lineDiscountPct: 0,
        notes: '',
        sortOrder: 0,
      });
    })();
    return () => { cancel = true; };
  }, [initialProductId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // In draft mode (materialize provided + nothing persisted yet) the live row
  // doesn't exist; fall back to the in-memory defaults so the form renders.
  const quote = liveQuote || draftQuote || null;
  const lines = useLiveQuery(
    () => db.quoteLines.where('quoteId').equals(quoteId).sortBy('sortOrder'),
    [quoteId],
    []
  );

  // Wrap any mutation so it lazily materializes the draft before touching the DB.
  const ensurePersisted = useCallback(async () => {
    if (materialize) await materialize();
  }, [materialize]);
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    []
  );

  const [picker, setPicker] = useState({ open: false });
  const [materialPicker, setMaterialPicker] = useState({ open: false, lineId: null });

  // Resolved line data for pricing
  const [resolved, setResolved] = useState([]);
  useEffect(() => {
    let cancel = false;
    (async () => {
      const out = [];
      for (const l of lines) {
        const variant = l.productVariantId ? await db.productVariants.get(l.productVariantId) : null;
        const product = variant ? await db.products.get(variant.productId) : null;
        const material = l.materialId ? await db.materials.get(l.materialId) : null;
        const color = l.colorId ? await db.materialColors.get(l.colorId) : null;
        const basePrice = resolveLineBasePrice({
          variant, material, priceOverride: l.priceOverride,
        });
        out.push({ ...l, variant, product, material, color, basePrice });
      }
      if (!cancel) setResolved(out);
    })();
    return () => { cancel = true; };
  }, [lines]);

  // Persist unitPrice on each line so the Quotes list can show a total
  // without recomputing from variants
  useEffect(() => {
    if (!resolved.length) return;
    (async () => {
      for (const r of resolved) {
        const unit = applyLineAdjustments(r.basePrice, r.lineMarginPct, r.lineDiscountPct);
        if (r.unitPrice !== unit) {
          await db.quoteLines.update(r.id, { unitPrice: unit });
        }
      }
    })();
  }, [resolved]);

  if (!quote) return <div className="text-sm text-ink-500">Cargando…</div>;

  async function updateQuote(patch) {
    await ensurePersisted();
    await db.quotes.put({ ...quote, ...patch, updatedAt: Date.now() });
  }

  async function addLineForVariant(variant) {
    await ensurePersisted();
    await db.quoteLines.put({
      id: newId(),
      quoteId,
      productVariantId: variant.id,
      materialId: null,
      colorId: null,
      qty: 1,
      unitPrice: 0,
      priceOverride: null,
      lineMarginPct: 0,
      lineDiscountPct: 0,
      notes: '',
      sortOrder: lines.length,
    });
  }

  async function removeLine(id) {
    await db.quoteLines.delete(id);
  }

  async function setLineMaterial(lineId, materialId, colorId = null) {
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    await db.quoteLines.update(lineId, { materialId, colorId });
  }

  const totals = computeTotals(
    resolved.map((r) => ({ qty: r.qty, basePrice: r.basePrice, lineMarginPct: r.lineMarginPct, lineDiscountPct: r.lineDiscountPct })),
    { marginPct: quote.marginPct, discountPct: quote.discountPct, taxPct: quote.taxPct, shipping: quote.shipping }
  );

  async function exportPdf() {
    const customer = quote.customerId ? customers.find((c) => c.id === quote.customerId) : null;
    const blob = await generateQuotePdf({ quote, settings, lines: resolved, totals, customer });
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
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
              <button onClick={() => setPicker({ open: true })} className="btn-secondary">
                <Plus size={14} /> Agregar artículo
              </button>
            </div>
            {resolved.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-ink-500">
                Sin artículos — toca <b>Agregar artículo</b> para elegir un producto.
              </div>
            ) : (
              <>
                {/* Mobile: stacked cards */}
                <ul className="md:hidden divide-y divide-ink-100">
                  {resolved.map((r) => (
                    <QuoteLineCard
                      key={r.id}
                      r={r}
                      quote={quote}
                      onPickMaterial={() => setMaterialPicker({ open: true, lineId: r.id })}
                      onRemove={() => removeLine(r.id)}
                      onQtyChange={(q) => db.quoteLines.update(r.id, { qty: q })}
                      onPriceOverride={(p) => db.quoteLines.update(r.id, { priceOverride: p })}
                      onLineDiscount={(p) => db.quoteLines.update(r.id, { lineDiscountPct: p })}
                      onLineMargin={(p) => db.quoteLines.update(r.id, { lineMarginPct: p })}
                      onNotes={(n) => db.quoteLines.update(r.id, { notes: n })}
                      onSwatchChange={(id) => db.quoteLines.update(r.id, { swatchImageId: id })}
                    />
                  ))}
                </ul>

                {/* Desktop: table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="table min-w-[760px]">
                    <thead>
                      <tr>
                        <th className="w-10" />
                        <th>Artículo</th>
                        <th>Material y color</th>
                        <th className="w-20 text-right">Cant.</th>
                        <th className="w-32 text-right">Unit.</th>
                        <th className="w-32 text-right">Total</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {resolved.map((r) => (
                        <QuoteLineRow
                          key={r.id}
                          r={r}
                          quote={quote}
                          onPickMaterial={() => setMaterialPicker({ open: true, lineId: r.id })}
                          onRemove={() => removeLine(r.id)}
                          onQtyChange={(q) => db.quoteLines.update(r.id, { qty: q })}
                          onPriceOverride={(p) => db.quoteLines.update(r.id, { priceOverride: p })}
                          onLineDiscount={(p) => db.quoteLines.update(r.id, { lineDiscountPct: p })}
                          onLineMargin={(p) => db.quoteLines.update(r.id, { lineMarginPct: p })}
                          onNotes={(n) => db.quoteLines.update(r.id, { notes: n })}
                          onSwatchChange={(id) => db.quoteLines.update(r.id, { swatchImageId: id })}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Sidebar */}
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
      </div>

      <ProductPickerModal
        open={picker.open}
        onClose={() => setPicker({ open: false })}
        onPick={(variant) => { setPicker({ open: false }); addLineForVariant(variant); }}
      />
      <MaterialPickerModal
        open={materialPicker.open}
        product={resolved.find((r) => r.id === materialPicker.lineId)?.product}
        onClose={() => setMaterialPicker({ open: false, lineId: null })}
        onPick={(material, color) => {
          setLineMaterial(materialPicker.lineId, material.id, color?.id || null);
          setMaterialPicker({ open: false, lineId: null });
        }}
      />

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
        <button onClick={() => setPicker({ open: true })} className="btn-secondary">
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

function Row({ label, value, quote, bold, muted }) {
  return (
    <div className={`flex items-center justify-between text-sm ${bold ? 'font-semibold text-base mt-1.5 pt-2 border-t border-ink-100' : ''} ${muted ? 'text-ink-500' : ''}`}>
      <span>{label}</span>
      <span>{formatMoney(value, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}</span>
    </div>
  );
}

