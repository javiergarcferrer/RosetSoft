import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { Plus, Trash2, Download, FileText, Save, ArrowLeft, GripVertical, ChevronDown, Minus } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import ImageView from '../components/ImageView.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import Modal from '../components/Modal.jsx';
import { DebouncedInput, DebouncedTextarea } from '../components/DebouncedInput.jsx';
import { db, newId } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { computeTotals, applyLineAdjustments, variantPriceForGrade, ITBIS_PCT } from '../lib/pricing.js';
import { formatMoney, formatDateTime } from '../lib/format.js';
import { generateQuotePdf, downloadBlob } from '../pdf/quotePdf.js';

export default function QuoteBuilder() {
  const navigate = useNavigate();
  const { profileId, settings } = useApp();
  const { quoteId: routeId } = useParams();
  const [search] = useSearchParams();

  const [quoteId, setQuoteId] = useState(routeId || null);
  const [creating, setCreating] = useState(!routeId);
  // Tracks a quote that THIS visit created via /quotes/new. If the user
  // leaves without ever giving it a customer, a name, or any line items,
  // we delete it on unmount to avoid leaving "empty quote" rows behind.
  const createdIdRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (routeId) {
      setQuoteId(routeId);
      setCreating(false);
      return;
    }
    (async () => {
      const id = newId();
      const number = (settings?.quoteCounter || 1000) + 1;
      await db.quotes.put({
        id,
        profileId,
        number,
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
      });
      await db.settings.put({ ...(settings || { profileId }), profileId, quoteCounter: number });
      if (!cancelled) {
        createdIdRef.current = id;
        setQuoteId(id);
        setCreating(false);
        // Optionally add an initial line for ?product=ID
        const initialProductId = search.get('product');
        if (initialProductId) {
          const variants = await db.productVariants.where('productId').equals(initialProductId).toArray();
          const firstVariant = variants.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))[0];
          if (firstVariant) {
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
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [routeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up abandoned empty quotes on unmount. Only runs for quotes this
  // visit created (createdIdRef set), so opening an existing quote and
  // leaving it never deletes user data.
  useEffect(() => {
    return () => {
      const id = createdIdRef.current;
      if (!id) return;
      // Fire-and-forget; we're leaving the page.
      (async () => {
        try {
          const q = await db.quotes.get(id);
          if (!q) return;
          const lineCount = await db.quoteLines.where('quoteId').equals(id).count();
          const untouched =
            lineCount === 0 &&
            !q.customerId &&
            !(q.name && q.name.trim());
          if (untouched) {
            await db.quotes.delete(id);
          }
        } catch (e) {
          // No-op: leaving the page anyway.
        }
      })();
    };
  }, []);

  if (creating || !quoteId) return <div className="text-sm text-ink-500">Preparing quote…</div>;
  return <Builder quoteId={quoteId} navigate={navigate} />;
}

function Builder({ quoteId, navigate }) {
  const { settings, profileId } = useApp();
  const quote = useLiveQuery(() => db.quotes.get(quoteId), [quoteId], null);
  const lines = useLiveQuery(
    () => db.quoteLines.where('quoteId').equals(quoteId).sortBy('sortOrder'),
    [quoteId],
    []
  );
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
        let basePrice = 0;
        if (l.priceOverride != null) basePrice = l.priceOverride;
        else if (variant && material?.grade) basePrice = variantPriceForGrade(variant, material.grade) ?? 0;
        else if (variant?.priceFixed != null) basePrice = variant.priceFixed;
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

  if (!quote) return <div className="text-sm text-ink-500">Loading…</div>;

  async function updateQuote(patch) {
    await db.quotes.put({ ...quote, ...patch, updatedAt: Date.now() });
  }

  async function addLineForVariant(variant) {
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
        <ArrowLeft size={12} /> Back to quotes
      </Link>
      <PageHeader
        title={`Quote #${quote.number}`}
        subtitle={`Updated ${formatDateTime(quote.updatedAt)}`}
        actions={
          <>
            <select
              value={quote.status || 'draft'}
              onChange={(e) => updateQuote({ status: e.target.value })}
              className="input max-w-[140px]"
            >
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="accepted">Accepted</option>
              <option value="declined">Declined</option>
              <option value="archived">Archived</option>
            </select>
            <button onClick={exportPdf} className="btn-primary hidden md:inline-flex"><Download size={14} /> Export PDF</button>
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {/* Quote header */}
          <div className="card card-pad space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="label">Quote name (internal)</div>
                <DebouncedInput className="input" value={quote.name || ''} onCommit={(v) => updateQuote({ name: v })} placeholder='e.g. "Smith residence — den"' />
              </div>
              <div>
                <div className="label">Customer</div>
                <select className="input" value={quote.customerId || ''} onChange={(e) => updateQuote({ customerId: e.target.value || null })}>
                  <option value="">— No customer —</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
              <h2 className="font-semibold">Line items</h2>
              <button onClick={() => setPicker({ open: true })} className="btn-secondary">
                <Plus size={14} /> Add item
              </button>
            </div>
            {resolved.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-ink-500">
                No items yet — click <b>Add item</b> to pick a product.
              </div>
            ) : (
              <>
                {/* Mobile: stacked cards */}
                <ul className="md:hidden divide-y divide-ink-100">
                  {resolved.map((r) => (
                    <LineCard
                      key={r.id}
                      r={r}
                      onPickMaterial={() => setMaterialPicker({ open: true, lineId: r.id })}
                      onRemove={() => removeLine(r.id)}
                      onQtyChange={(q) => db.quoteLines.update(r.id, { qty: q })}
                      onPriceOverride={(p) => db.quoteLines.update(r.id, { priceOverride: p })}
                      onLineDiscount={(p) => db.quoteLines.update(r.id, { lineDiscountPct: p })}
                      onLineMargin={(p) => db.quoteLines.update(r.id, { lineMarginPct: p })}
                      onNotes={(n) => db.quoteLines.update(r.id, { notes: n })}
                      onSwatchChange={(id) => db.quoteLines.update(r.id, { swatchImageId: id })}
                      quote={quote}
                    />
                  ))}
                </ul>

                {/* Desktop: table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="table min-w-[760px]">
                    <thead>
                      <tr>
                        <th className="w-10" />
                        <th>Item</th>
                        <th>Material / color</th>
                        <th className="w-20 text-right">Qty</th>
                        <th className="w-32 text-right">Unit</th>
                        <th className="w-32 text-right">Line total</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {resolved.map((r) => (
                        <LineRow
                          key={r.id}
                          r={r}
                          onPickMaterial={() => setMaterialPicker({ open: true, lineId: r.id })}
                          onRemove={() => removeLine(r.id)}
                          onQtyChange={(q) => db.quoteLines.update(r.id, { qty: q })}
                          onPriceOverride={(p) => db.quoteLines.update(r.id, { priceOverride: p })}
                          onLineDiscount={(p) => db.quoteLines.update(r.id, { lineDiscountPct: p })}
                          onLineMargin={(p) => db.quoteLines.update(r.id, { lineMarginPct: p })}
                          onNotes={(n) => db.quoteLines.update(r.id, { notes: n })}
                          onSwatchChange={(id) => db.quoteLines.update(r.id, { swatchImageId: id })}
                          quote={quote}
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
                <DebouncedInput className="input" type="number" value={quote.discountPct ?? 0} onCommit={(v) => updateQuote({ discountPct: Number(v) || 0 })} />
              </div>
              <div>
                <div className="label">Envío (USD)</div>
                <DebouncedInput className="input" type="number" value={quote.shipping ?? 0} onCommit={(v) => updateQuote({ shipping: Number(v) || 0 })} />
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
              <div className="label">Términos (se imprimen en PDF)</div>
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
        lineId={materialPicker.lineId}
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
          <Plus size={14} /> Item
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

function LineRow({ r, onPickMaterial, onRemove, onQtyChange, onPriceOverride, onLineMargin, onLineDiscount, onNotes, onSwatchChange, quote }) {
  const unit = applyLineAdjustments(r.basePrice, r.lineMarginPct, r.lineDiscountPct);
  const lineTotal = unit * (r.qty || 0);
  return (
    <>
      <tr className="align-top">
        <td>
          <GripVertical size={14} className="text-ink-300" />
        </td>
        <td>
          <div className="flex gap-3 items-start">
            <div className="w-20 h-16 rounded bg-white border border-ink-100 overflow-hidden flex-shrink-0">
              <ImageView id={r.variant?.imageId || r.product?.heroImageId || r.product?.vectorImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
            </div>
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">{r.product?.name || '(missing product)'}</div>
              <div className="text-xs text-ink-500 truncate">{r.variant?.name || '—'}</div>
              {r.variant?.reference && <div className="font-mono text-[10px] text-ink-400">{r.variant.reference}</div>}
            </div>
          </div>
        </td>
        <td>
          <button
            onClick={onPickMaterial}
            className="flex items-center gap-2 text-left hover:bg-ink-50 rounded p-1 -m-1 w-full"
          >
            <div className="w-9 h-9 rounded bg-ink-100 overflow-hidden flex-shrink-0">
              <ImageView id={r.swatchImageId || r.color?.swatchImageId} className="w-full h-full object-cover" placeholderClassName="w-full h-full" />
            </div>
            <div className="min-w-0">
              {r.material ? (
                <>
                  <div className="text-sm font-medium truncate">{r.material.name} <span className="text-ink-500 font-normal">· Grade {r.material.grade}</span></div>
                  <div className="text-xs text-ink-500 truncate">{r.color?.name || 'Pick color'}</div>
                </>
              ) : (
                <span className="text-xs text-brand-600 font-medium">Pick fabric / leather…</span>
              )}
            </div>
          </button>
        </td>
        <td>
          <input type="number" min="0" className="input text-right" value={r.qty ?? 1} onChange={(e) => onQtyChange(Math.max(0, Number(e.target.value) || 0))} />
        </td>
        <td className="text-right">
          <div>{formatMoney(unit, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}</div>
          {r.basePrice === 0 && r.material && (
            <div className="text-[10px] text-amber-600 mt-0.5">No grade-{r.material.grade} price</div>
          )}
        </td>
        <td className="text-right font-medium">{formatMoney(lineTotal, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}</td>
        <td>
          <button onClick={onRemove} className="text-ink-400 hover:text-red-600"><Trash2 size={14} /></button>
        </td>
      </tr>
      <tr>
        <td colSpan={7} className="!py-2 !border-b-0 border-b border-ink-50">
          <div className="flex flex-col sm:flex-row sm:items-start gap-4 px-3 py-2 bg-ink-50 rounded">
            <div className="w-24 flex-shrink-0">
              <ImageDrop
                imageId={r.swatchImageId}
                onChange={(id) => onSwatchChange(id)}
                kind="quote-line-swatch"
                ownerId={r.id}
                label="Swatch override"
                imgClassName="w-full aspect-square object-cover rounded"
                allowUrl={false}
              />
            </div>
            <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-3 self-center">
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Override unit ($)</div>
                <DebouncedInput
                  type="number"
                  className="w-full bg-transparent border-0 px-0 py-1 text-sm focus:outline-none focus:ring-0"
                  placeholder={String(r.basePrice || 0)}
                  value={r.priceOverride ?? ''}
                  onCommit={(v) => onPriceOverride(v === '' ? null : Number(v))}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Margin %</div>
                <DebouncedInput
                  type="number"
                  className="w-full bg-transparent border-0 px-0 py-1 text-sm focus:outline-none focus:ring-0"
                  value={r.lineMarginPct ?? 0}
                  onCommit={(v) => onLineMargin(Number(v) || 0)}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Discount %</div>
                <DebouncedInput
                  type="number"
                  className="w-full bg-transparent border-0 px-0 py-1 text-sm focus:outline-none focus:ring-0"
                  value={r.lineDiscountPct ?? 0}
                  onCommit={(v) => onLineDiscount(Number(v) || 0)}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Notes</div>
                <DebouncedInput
                  className="w-full bg-transparent border-0 px-0 py-1 text-sm focus:outline-none focus:ring-0"
                  value={r.notes || ''}
                  onCommit={(v) => onNotes(v)}
                  placeholder="e.g. extra cushion, COM"
                />
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

function LineCard({ r, onPickMaterial, onRemove, onQtyChange, onPriceOverride, onLineMargin, onLineDiscount, onNotes, onSwatchChange, quote }) {
  const [expanded, setExpanded] = useState(false);
  const unit = applyLineAdjustments(r.basePrice, r.lineMarginPct, r.lineDiscountPct);
  const lineTotal = unit * (r.qty || 0);
  const fmt = (v) => formatMoney(v, quote.currencyCode || 'USD', quote.rates || { USD: 1 });
  return (
    <li className="px-4 py-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-20 h-16 rounded bg-white border border-ink-100 overflow-hidden flex-shrink-0">
          <ImageView id={r.variant?.imageId || r.product?.heroImageId || r.product?.vectorImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{r.product?.name || '(missing product)'}</div>
          <div className="text-xs text-ink-500 truncate">{r.variant?.name || '—'}</div>
          {r.variant?.reference && <div className="font-mono text-[10px] text-ink-400">{r.variant.reference}</div>}
        </div>
        <button onClick={onRemove} className="text-ink-400 hover:text-red-600 p-2 -m-2" aria-label="Remove">
          <Trash2 size={16} />
        </button>
      </div>

      <button
        onClick={onPickMaterial}
        className="flex items-center gap-2 text-left w-full border border-ink-100 rounded p-2 hover:bg-ink-50"
      >
        <div className="w-9 h-9 rounded bg-ink-100 overflow-hidden flex-shrink-0">
          <ImageView id={r.swatchImageId || r.color?.swatchImageId} className="w-full h-full object-cover" placeholderClassName="w-full h-full" />
        </div>
        <div className="min-w-0 flex-1">
          {r.material ? (
            <>
              <div className="text-sm font-medium truncate">{r.material.name} <span className="text-ink-500 font-normal">· Grade {r.material.grade}</span></div>
              <div className="text-xs text-ink-500 truncate">{r.color?.name || 'Pick color'}</div>
            </>
          ) : (
            <span className="text-sm text-brand-600 font-medium">Pick fabric / leather…</span>
          )}
        </div>
      </button>

      <div className="flex items-center justify-between gap-3">
        <QtyStepper value={r.qty ?? 1} onChange={onQtyChange} />
        <div className="text-right">
          <div className="text-base font-semibold">{fmt(lineTotal)}</div>
          <div className="text-[11px] text-ink-500">{fmt(unit)} c/u</div>
          {r.basePrice === 0 && r.material && (
            <div className="text-[10px] text-amber-600 mt-0.5">No grade-{r.material.grade} price</div>
          )}
        </div>
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-xs text-ink-500 hover:text-ink-900 py-2 border-t border-ink-100"
      >
        <span>Override / margin / discount / notes</span>
        <ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="flex items-start gap-3 bg-ink-50 rounded p-3">
          <div className="w-20 flex-shrink-0">
            <ImageDrop
              imageId={r.swatchImageId}
              onChange={(id) => onSwatchChange(id)}
              kind="quote-line-swatch"
              ownerId={r.id}
              label="Swatch"
              imgClassName="w-full aspect-square object-cover rounded"
              allowUrl={false}
            />
          </div>
          <div className="flex-1 grid grid-cols-2 gap-3">
            <div>
              <div className="label">Override unit ($)</div>
              <DebouncedInput
                type="number"
                className="input"
                placeholder={String(r.basePrice || 0)}
                value={r.priceOverride ?? ''}
                onCommit={(v) => onPriceOverride(v === '' ? null : Number(v))}
              />
            </div>
            <div>
              <div className="label">Margin %</div>
              <DebouncedInput
                type="number"
                className="input"
                value={r.lineMarginPct ?? 0}
                onCommit={(v) => onLineMargin(Number(v) || 0)}
              />
            </div>
            <div>
              <div className="label">Discount %</div>
              <DebouncedInput
                type="number"
                className="input"
                value={r.lineDiscountPct ?? 0}
                onCommit={(v) => onLineDiscount(Number(v) || 0)}
              />
            </div>
            <div>
              <div className="label">Notes</div>
              <DebouncedInput
                className="input"
                value={r.notes || ''}
                onCommit={(v) => onNotes(v)}
                placeholder="e.g. COM"
              />
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function QtyStepper({ value, onChange }) {
  return (
    <div className="inline-flex items-center border border-ink-200 rounded-md">
      <button
        onClick={() => onChange(Math.max(0, (value || 0) - 1))}
        className="px-3 py-2 text-ink-600 hover:bg-ink-100"
        aria-label="Decrement"
      >
        <Minus size={14} />
      </button>
      <DebouncedInput
        type="number"
        min="0"
        value={value ?? 0}
        onCommit={(v) => onChange(Math.max(0, Number(v) || 0))}
        className="w-12 text-center bg-transparent border-0 px-0 focus:outline-none focus:ring-0"
      />
      <button
        onClick={() => onChange((value || 0) + 1)}
        className="px-3 py-2 text-ink-600 hover:bg-ink-100"
        aria-label="Increment"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function ProductPickerModal({ open, onClose, onPick }) {
  const products = useLiveQuery(() => db.products.toArray(), [], []);
  const variants = useLiveQuery(() => db.productVariants.toArray(), [], []);
  const [q, setQ] = useState('');

  const variantsByProduct = useMemo(() => {
    const m = new Map();
    for (const v of variants) {
      const arr = m.get(v.productId) || [];
      arr.push(v);
      m.set(v.productId, arr);
    }
    return m;
  }, [variants]);

  const filteredProducts = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return products.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60);
    return products.filter((p) => p.name.toLowerCase().includes(needle) || (p.designer || '').toLowerCase().includes(needle)).slice(0, 60);
  }, [products, q]);

  return (
    <Modal open={open} onClose={onClose} title="Add product" size="lg">
      <div className="mb-3">
        <input autoFocus className="input" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2 max-h-[60vh] overflow-y-auto">
        {filteredProducts.map((p) => {
          const pv = variantsByProduct.get(p.id) || [];
          return (
            <div key={p.id} className="border border-ink-100 rounded-md hover:border-ink-300 transition">
              <div className="flex items-center gap-3 px-3 py-2 border-b border-ink-100">
                <div className="w-16 h-12 rounded bg-white border border-ink-100 overflow-hidden flex-shrink-0">
                  <ImageView id={p.vectorImageId || p.heroImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{p.name}</div>
                  <div className="text-[10px] text-ink-500 truncate">{p.designer || ''}</div>
                </div>
              </div>
              <div className="px-2 py-1.5 space-y-0.5">
                {pv.length === 0 ? (
                  <div className="text-[11px] text-ink-400 px-2 py-1">No variants</div>
                ) : pv.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => onPick(v)}
                    className="w-full flex items-center justify-between text-left text-xs px-2 py-1.5 rounded hover:bg-ink-100"
                  >
                    <span className="truncate">{v.name}</span>
                    <span className="text-[10px] text-ink-400 font-mono ml-2">{v.reference || ''}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {filteredProducts.length === 0 && (
          <div className="col-span-2 text-center text-sm text-ink-500 py-10">No products found.</div>
        )}
      </div>
    </Modal>
  );
}

function MaterialPickerModal({ open, onClose, onPick, product }) {
  const materials = useLiveQuery(() => db.materials.toArray(), [], []);
  const colors = useLiveQuery(() => db.materialColors.toArray(), [], []);
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [gradeFilter, setGradeFilter] = useState('');
  const [activeMaterial, setActiveMaterial] = useState(null);

  useEffect(() => {
    if (!open) { setActiveMaterial(null); setQ(''); }
  }, [open]);

  const matColors = useMemo(() => {
    if (!activeMaterial) return [];
    return colors.filter((c) => c.materialId === activeMaterial.id);
  }, [activeMaterial, colors]);

  const filteredMaterials = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const impossibilities = (product?.technicalImpossibilities || []).map((s) => s.toUpperCase());
    return materials
      .filter((m) => (kindFilter ? m.kind === kindFilter : true))
      .filter((m) => (gradeFilter ? m.grade === gradeFilter : true))
      .filter((m) => !needle ? true : m.name.toLowerCase().includes(needle) || (m.composition || '').toLowerCase().includes(needle))
      .sort((a, b) => {
        const aBlocked = impossibilities.includes((a.name || '').toUpperCase());
        const bBlocked = impossibilities.includes((b.name || '').toUpperCase());
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
  }, [materials, q, kindFilter, gradeFilter, product]);

  return (
    <Modal open={open} onClose={onClose} title="Pick material & color" size="xl">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
        <input autoFocus className="input flex-1" placeholder="Search materials…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input sm:max-w-[160px]" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">All types</option>
          <option value="fabric">Fabric</option>
          <option value="leather">Leather</option>
          <option value="outdoor-fabric">Outdoor</option>
        </select>
        <select className="input sm:max-w-[120px]" value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
          <option value="">All grades</option>
          {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((g) => <option key={g} value={g}>Grade {g}</option>)}
          <option value="S">Grade S</option>
        </select>
      </div>

      {!activeMaterial ? (
        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-ink-100">
            {filteredMaterials.map((m) => {
              const blocked = (product?.technicalImpossibilities || []).map((s) => s.toUpperCase()).includes(m.name.toUpperCase());
              const colorCount = colors.filter((c) => c.materialId === m.id).length;
              return (
                <button
                  key={m.id}
                  onClick={() => !blocked && setActiveMaterial(m)}
                  disabled={blocked}
                  className={`w-full text-left p-3 flex items-start justify-between gap-2 ${blocked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-ink-50 active:bg-ink-100'}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{m.name}</div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="capitalize text-[10px] text-ink-700">{m.kind.replace('-', ' ')}</span>
                      <span className="badge">{m.grade || '—'}</span>
                      <span className="text-[10px] text-ink-500">{colorCount} {colorCount === 1 ? 'color' : 'colores'}</span>
                    </div>
                    {m.composition && (
                      <div className="text-[11px] text-ink-500 mt-1 truncate">{m.composition}</div>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-xs text-brand-600">
                    {blocked ? <span className="text-red-600 text-[11px]">Not allowed</span> : 'Pick →'}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="table min-w-[640px]">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Grade</th>
                  <th>Composition</th>
                  <th>Colors</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredMaterials.map((m) => {
                  const blocked = (product?.technicalImpossibilities || []).map((s) => s.toUpperCase()).includes(m.name.toUpperCase());
                  const colorCount = colors.filter((c) => c.materialId === m.id).length;
                  return (
                    <tr key={m.id} className={blocked ? 'opacity-50' : ''}>
                      <td className="font-medium">{m.name}</td>
                      <td className="capitalize text-ink-700 text-xs">{m.kind.replace('-', ' ')}</td>
                      <td><span className="badge">{m.grade || '—'}</span></td>
                      <td className="text-xs text-ink-500 max-w-xs truncate" title={m.composition}>{m.composition || '—'}</td>
                      <td className="text-ink-500">{colorCount}</td>
                      <td className="text-right">
                        {blocked ? (
                          <span className="text-[11px] text-red-600">Not allowed</span>
                        ) : (
                          <button onClick={() => setActiveMaterial(m)} className="text-xs text-brand-600 hover:underline">Pick →</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <button onClick={() => setActiveMaterial(null)} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
            <div className="text-sm">
              <span className="font-medium">{activeMaterial.name}</span>
              <span className="text-ink-500"> · Grade {activeMaterial.grade}</span>
            </div>
            <button onClick={() => onPick(activeMaterial, null)} className="btn-secondary text-xs">Use without color</button>
          </div>
          {matColors.length === 0 ? (
            <div className="text-center text-sm text-ink-500 py-10">
              No colors saved for {activeMaterial.name}.
              <div className="mt-2"><button onClick={() => onPick(activeMaterial, null)} className="btn-primary">Use anyway</button></div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 max-h-[55vh] overflow-y-auto">
              {matColors.map((c) => (
                <button key={c.id} onClick={() => onPick(activeMaterial, c)} className="card hover:border-ink-300 transition text-left overflow-hidden">
                  <div className="aspect-square bg-ink-100">
                    <ImageView id={c.swatchImageId} className="w-full h-full object-cover" placeholderClassName="w-full h-full" />
                  </div>
                  <div className="px-2.5 py-1.5">
                    <div className="text-xs font-medium truncate">{c.name}</div>
                    <div className="text-[10px] text-ink-500 font-mono">{c.code || '—'}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
