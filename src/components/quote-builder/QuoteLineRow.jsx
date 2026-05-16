import { GripVertical, Trash2 } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import ImageDrop from '../ImageDrop.jsx';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';

/**
 * Desktop table row for a quote line. The header row carries item / material
 * / qty / unit / total; the second row hosts the override-and-notes panel so
 * it stays attached to its parent line when the table wraps to a new page.
 */
export default function QuoteLineRow({
  r,
  quote,
  onPickMaterial,
  onRemove,
  onQtyChange,
  onPriceOverride,
  onLineMargin,
  onLineDiscount,
  onNotes,
  onSwatchChange,
}) {
  const unit = applyLineAdjustments(r.basePrice, r.lineMarginPct, r.lineDiscountPct);
  const lineTotal = unit * (r.qty || 0);
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
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
              <div className="font-medium text-sm truncate">{r.product?.name || '(producto faltante)'}</div>
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
                  <div className="text-sm font-medium truncate">{r.material.name} <span className="text-ink-500 font-normal">· Grado {r.material.grade}</span></div>
                  <div className="text-xs text-ink-500 truncate">{r.color?.name || 'Elegir color'}</div>
                </>
              ) : (
                <span className="text-xs text-brand-600 font-medium">Elegir tela o cuero…</span>
              )}
            </div>
          </button>
        </td>
        <td>
          <input type="number" min="0" className="input text-right" value={r.qty ?? 1} onChange={(e) => onQtyChange(Math.max(0, Number(e.target.value) || 0))} />
        </td>
        <td className="text-right">
          <div>{formatMoney(unit, currency, rates)}</div>
          {r.basePrice === 0 && r.material && (
            <div className="text-[10px] text-amber-600 mt-0.5">Sin precio para grado {r.material.grade}</div>
          )}
        </td>
        <td className="text-right font-medium">{formatMoney(lineTotal, currency, rates)}</td>
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
                label="Muestra personalizada"
                imgClassName="w-full aspect-square object-cover rounded"
                allowUrl={false}
              />
            </div>
            <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-3 self-center">
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Precio unit. ($)</div>
                <DebouncedInput
                  type="number"
                  min="0"
                  className="w-full bg-transparent border-0 px-0 py-1 text-sm focus:outline-none focus:ring-0"
                  placeholder={String(r.basePrice || 0)}
                  value={r.priceOverride ?? ''}
                  onCommit={(v) => onPriceOverride(v === '' ? null : Math.max(0, Number(v) || 0))}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Margen %</div>
                <DebouncedInput
                  type="number"
                  className="w-full bg-transparent border-0 px-0 py-1 text-sm focus:outline-none focus:ring-0"
                  value={r.lineMarginPct ?? 0}
                  onCommit={(v) => onLineMargin(Number(v) || 0)}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Descuento %</div>
                <DebouncedInput
                  type="number"
                  min="0"
                  max="100"
                  className="w-full bg-transparent border-0 px-0 py-1 text-sm focus:outline-none focus:ring-0"
                  value={r.lineDiscountPct ?? 0}
                  onCommit={(v) => onLineDiscount(clampPct(v))}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Notas</div>
                <DebouncedInput
                  className="w-full bg-transparent border-0 px-0 py-1 text-sm focus:outline-none focus:ring-0"
                  value={r.notes || ''}
                  onCommit={(v) => onNotes(v)}
                  placeholder="p. ej. cojín extra, COM"
                />
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}
