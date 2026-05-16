import { useState } from 'react';
import { Trash2, ChevronDown } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import ImageDrop from '../ImageDrop.jsx';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';
import QtyStepper from './QtyStepper.jsx';

/**
 * Mobile card for a quote line. The override / margin / discount / notes
 * panel is collapsed by default so the card stays scannable; tapping the
 * disclosure reveals it. Same callbacks as QuoteLineRow.
 */
export default function QuoteLineCard({
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
          <div className="font-medium text-sm truncate">{r.product?.name || '(producto faltante)'}</div>
          <div className="text-xs text-ink-500 truncate">{r.variant?.name || '—'}</div>
          {r.variant?.reference && <div className="font-mono text-[10px] text-ink-400">{r.variant.reference}</div>}
        </div>
        <button onClick={onRemove} className="text-ink-400 hover:text-red-600 p-2 -m-2" aria-label="Eliminar">
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
              <div className="text-sm font-medium truncate">{r.material.name} <span className="text-ink-500 font-normal">· Grado {r.material.grade}</span></div>
              <div className="text-xs text-ink-500 truncate">{r.color?.name || 'Elegir color'}</div>
            </>
          ) : (
            <span className="text-sm text-brand-600 font-medium">Elegir tela o cuero…</span>
          )}
        </div>
      </button>

      <div className="flex items-center justify-between gap-3">
        <QtyStepper value={r.qty ?? 1} onChange={onQtyChange} />
        <div className="text-right">
          <div className="text-base font-semibold">{fmt(lineTotal)}</div>
          <div className="text-[11px] text-ink-500">{fmt(unit)} c/u</div>
          {r.basePrice === 0 && r.material && (
            <div className="text-[10px] text-amber-600 mt-0.5">Sin precio para grado {r.material.grade}</div>
          )}
        </div>
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-xs text-ink-500 hover:text-ink-900 py-2 border-t border-ink-100"
      >
        <span>Precio / margen / descuento / notas</span>
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
              label="Muestra"
              imgClassName="w-full aspect-square object-cover rounded"
              allowUrl={false}
            />
          </div>
          <div className="flex-1 grid grid-cols-2 gap-3">
            <div>
              <div className="label">Precio unit. ($)</div>
              <DebouncedInput
                type="number"
                min="0"
                className="input"
                placeholder={String(r.basePrice || 0)}
                value={r.priceOverride ?? ''}
                onCommit={(v) => onPriceOverride(v === '' ? null : Math.max(0, Number(v) || 0))}
              />
            </div>
            <div>
              <div className="label">Margen %</div>
              <DebouncedInput
                type="number"
                className="input"
                value={r.lineMarginPct ?? 0}
                onCommit={(v) => onLineMargin(Number(v) || 0)}
              />
            </div>
            <div>
              <div className="label">Descuento %</div>
              <DebouncedInput
                type="number"
                min="0"
                max="100"
                className="input"
                value={r.lineDiscountPct ?? 0}
                onCommit={(v) => onLineDiscount(clampPct(v))}
              />
            </div>
            <div>
              <div className="label">Notas</div>
              <DebouncedInput
                className="input"
                value={r.notes || ''}
                onCommit={(v) => onNotes(v)}
                placeholder="p. ej. COM"
              />
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
