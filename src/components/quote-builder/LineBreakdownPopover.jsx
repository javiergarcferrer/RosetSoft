import { useEffect, useRef } from 'react';
import {
  applyLineAdjustments, isCompoundLine, lineBasePrice, lineQty,
} from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';

/**
 * The "show me the math" popover. Anchored to the line total — opens on
 * click, closes on outside-click or Escape. Surfaces each step of the
 * per-line calculation so a dealer reviewing a quote with a client never
 * has to apologise for a "weird" number.
 *
 * Shown rows:
 *   Base                $4,180.00
 *   Margen +20%          +836.00     (only if margin ≠ 0)
 *   Descuento –10%      –501.60      (only if discount ≠ 0)
 *   Precio unitario     $4,514.40
 *   × Cantidad                × 1
 *   ───────────────────────────
 *   Total línea         $4,514.40
 */
export default function LineBreakdownPopover({ line, currency, rates, onClose, anchor = 'right' }) {
  const ref = useRef(null);
  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const compound = isCompoundLine(line);
  const base = lineBasePrice(line);
  const margin = Number(line.lineMarginPct) || 0;
  const discount = Number(line.lineDiscountPct) || 0;
  const qty = lineQty(line);

  const withMargin = base * (1 + margin / 100);
  const marginAmt = withMargin - base;
  const discountAmt = withMargin * (discount / 100);
  const unit = applyLineAdjustments(base, margin, discount);
  const total = unit * qty;

  const fmt = (v) => formatMoney(v, currency, rates);

  return (
    <div
      ref={ref}
      className={`absolute z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-ink-200 bg-white shadow-pop p-3 ${
        anchor === 'right' ? 'right-0' : 'left-0'
      }`}
    >
      <div className="eyebrow font-semibold tracking-wide mb-2">
        Cómo se calcula
      </div>
      {compound && (
        <>
          {(line.components || []).map((c, i) => {
            const cqty = Number(c.qty) || 0;
            const cprice = Number(c.unitPrice) || 0;
            const subtotal = cqty * cprice;
            return (
              <Row
                key={c.id || i}
                label={`${c.name || `Componente ${i + 1}`} (${cqty} × ${fmt(cprice)})`}
                value={fmt(subtotal)}
                muted
              />
            );
          })}
          <Divider />
        </>
      )}
      <Row label={compound ? 'Subtotal componentes' : 'Base'} value={fmt(base)} />
      {margin !== 0 && (
        <Row label={`Margen ${margin > 0 ? '+' : ''}${margin}%`} value={`${marginAmt >= 0 ? '+' : ''}${fmt(marginAmt)}`} muted />
      )}
      {discount !== 0 && (
        <Row label={`Descuento ${discount > 0 ? '–' : ''}${discount}%`} value={`–${fmt(discountAmt)}`} muted />
      )}
      {!compound && (
        <>
          <Divider />
          <Row label="Precio unitario" value={fmt(unit)} />
          <Row label="× Cantidad" value={`× ${qty}`} muted />
        </>
      )}
      <Divider />
      <Row label="Total línea" value={fmt(total)} bold />
    </div>
  );
}

function Row({ label, value, muted, bold }) {
  return (
    <div className={`flex items-baseline justify-between gap-x-3 gap-y-0.5 py-0.5 text-xs tabular-nums ${
      muted ? 'text-ink-500' : 'text-ink-900'
    } ${bold ? 'font-semibold text-sm' : ''}`}>
      <span className="min-w-0 break-words">{label}</span>
      <span className="whitespace-nowrap flex-shrink-0">{value}</span>
    </div>
  );
}

function Divider() {
  return <div className="my-1.5 border-t border-ink-100" />;
}
