import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { ShoppingBag, Trash2, X, ChevronRight, Minus, Plus } from 'lucide-react';
import { useCart } from '../context/CartContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db } from '../db/database.js';
import { formatMoney } from '../lib/format.js';
import { variantPriceForGrade, applyLineAdjustments, ITBIS_PCT } from '../lib/pricing.js';
import ImageView from './ImageView.jsx';

/**
 * Running quote sidebar. Lives on the right of the catalog and quote pages.
 * Shows the active "cart" (a draft quote). User can add items from the catalog
 * without losing context.
 */
export default function QuoteCart() {
  const { cartId, open, setOpen, removeLine, updateLine, clearCart, finalizeCart } = useCart();
  const { settings } = useApp();
  const navigate = useNavigate();

  const lines = useLiveQuery(
    () => (cartId ? db.quoteLines.where('quoteId').equals(cartId).sortBy('sortOrder') : []),
    [cartId],
    []
  );
  const quote = useLiveQuery(() => (cartId ? db.quotes.get(cartId) : null), [cartId], null);

  // Resolve each line for display
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
        else if (variant) {
          // Default to lowest available grade price if no material chosen yet
          const vals = Object.values(variant.priceByGrade || {});
          basePrice = vals.length ? Math.min(...vals) : 0;
        }
        out.push({ ...l, variant, product, material, color, basePrice });
      }
      if (!cancel) setResolved(out);
    })();
    return () => { cancel = true; };
  }, [lines]);

  const rates = settings?.currencyRates || { USD: 1, DOP: 60.0 };
  const currency = settings?.defaultCurrency || 'DOP';

  const subtotal = resolved.reduce((acc, r) => {
    const unit = applyLineAdjustments(r.basePrice, r.lineMarginPct, r.lineDiscountPct);
    return acc + unit * (r.qty || 0);
  }, 0);

  const discountPct = quote?.discountPct || 0;
  const discountAmt = subtotal * (discountPct / 100);
  const afterDiscount = subtotal - discountAmt;
  const itbis = afterDiscount * (ITBIS_PCT / 100);
  const total = afterDiscount + itbis;

  async function handleFinalize() {
    if (!resolved.length) return;
    const id = await finalizeCart();
    if (id) navigate(`/quotes/${id}`);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-30 bg-ink-900 text-white rounded-full shadow-2xl px-5 py-3 flex items-center gap-2 hover:bg-ink-800 transition"
        title="Abrir cotización"
      >
        <ShoppingBag size={18} />
        <span className="font-medium">{resolved.length}</span>
        {resolved.length > 0 && (
          <span className="text-xs opacity-75 ml-1 border-l border-ink-700 pl-2.5">
            {formatMoney(total, currency, rates)}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="fixed top-0 right-0 z-30 w-[380px] h-full bg-white border-l border-ink-100 shadow-2xl flex flex-col">
      <div className="px-5 py-4 border-b border-ink-100 flex items-center justify-between">
        <div>
          <div className="font-semibold flex items-center gap-2">
            <ShoppingBag size={16} /> Cotización en curso
          </div>
          <div className="text-[11px] text-ink-500 mt-0.5">
            {resolved.length} {resolved.length === 1 ? 'artículo' : 'artículos'} · borrador
          </div>
        </div>
        <button onClick={() => setOpen(false)} className="text-ink-400 hover:text-ink-900 p-1">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {resolved.length === 0 ? (
          <div className="text-center text-sm text-ink-500 py-16 px-6">
            Aún no has agregado artículos. Haz clic en <b>+ Agregar</b> en cualquier producto del catálogo.
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {resolved.map((r) => {
              const unit = applyLineAdjustments(r.basePrice, r.lineMarginPct, r.lineDiscountPct);
              const lineTotal = unit * (r.qty || 0);
              return (
                <li key={r.id} className="px-5 py-3.5">
                  <div className="flex items-start gap-3">
                    <div className="w-20 h-16 rounded bg-white border border-ink-100 overflow-hidden flex-shrink-0">
                      <ImageView id={r.variant?.imageId || r.product?.heroImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate" title={r.product?.name}>
                        {r.product?.name || '(producto)'}
                      </div>
                      <div className="text-xs text-ink-500 truncate" title={r.variant?.name}>
                        {r.variant?.name || '—'}
                      </div>
                      {r.material && (
                        <div className="text-[11px] text-ink-500 truncate">
                          Tela: <span className="text-ink-700">{r.material.name}</span>{r.material.grade ? ` · ${r.material.grade}` : ''}
                          {r.color ? ` · ${r.color.name}` : ''}
                        </div>
                      )}
                      <div className="flex items-center justify-between mt-2">
                        <QtyStepper qty={r.qty || 0} onChange={(q) => updateLine(r.id, { qty: q })} />
                        <div className="text-right">
                          <div className="text-sm font-semibold">{formatMoney(lineTotal, currency, rates)}</div>
                          <div className="text-[10px] text-ink-500">{formatMoney(unit, currency, rates)} c/u</div>
                        </div>
                      </div>
                    </div>
                    <button onClick={() => removeLine(r.id)} className="text-ink-400 hover:text-red-600 p-1">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-ink-100 px-5 py-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between text-ink-600">
          <span>Subtotal</span>
          <span>{formatMoney(subtotal, currency, rates)}</span>
        </div>
        {discountPct ? (
          <div className="flex items-center justify-between text-ink-600">
            <span>Descuento ({discountPct}%)</span>
            <span>-{formatMoney(discountAmt, currency, rates)}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between text-ink-600">
          <span>ITBIS ({ITBIS_PCT}%)</span>
          <span>{formatMoney(itbis, currency, rates)}</span>
        </div>
        <div className="flex items-center justify-between font-semibold text-base pt-1.5 border-t border-ink-100">
          <span>Total</span>
          <span>{formatMoney(total, currency, rates)}</span>
        </div>
      </div>

      <div className="border-t border-ink-100 px-5 py-3 flex items-center gap-2">
        <button onClick={clearCart} disabled={!resolved.length} className="btn-ghost text-red-600 hover:bg-red-50 text-xs">
          Vaciar
        </button>
        <div className="flex-1" />
        <button
          onClick={handleFinalize}
          disabled={!resolved.length}
          className="btn-primary"
        >
          Generar cotización <ChevronRight size={14} />
        </button>
      </div>
    </aside>
  );
}

function QtyStepper({ qty, onChange }) {
  return (
    <div className="inline-flex items-center border border-ink-200 rounded">
      <button
        onClick={() => onChange(Math.max(0, qty - 1))}
        className="px-1.5 py-0.5 text-ink-600 hover:bg-ink-100"
      >
        <Minus size={12} />
      </button>
      <input
        type="number"
        min="0"
        value={qty}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="w-10 text-center text-sm bg-transparent border-0 px-1 focus:outline-none"
      />
      <button
        onClick={() => onChange(qty + 1)}
        className="px-1.5 py-0.5 text-ink-600 hover:bg-ink-100"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
