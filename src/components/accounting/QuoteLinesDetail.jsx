import { formatMoney } from '../../lib/format.js';
import { isPricedLine } from '../../lib/constants.js';
import { applyLineAdjustments, isCompoundLine } from '../../lib/pricing.js';

/**
 * The quote's billable line items, flattened for an invoice view — one row per
 * priced line, exploding a compound family into its priced components, each with
 * the line's margin/discount applied. SHARED so the Ventas workspace card, the
 * Facturación invoice drawer and the facturar flow all read the same breakdown
 * (the "three surfaces can't drift" rule). Pure: quote + lines → display rows.
 */
export function invoiceLinesForQuote(quote, lines) {
  const out = [];
  const itemLines = (lines || [])
    .filter(isPricedLine)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  for (const l of itemLines) {
    if (isCompoundLine(l)) {
      const familyName = (l.name || '').trim();
      for (const c of l.components || []) {
        const unit = applyLineAdjustments(c.unitPrice, l.lineMarginPct, l.lineDiscountPct);
        const qty = Number(c.qty) || 0;
        const componentName = [c.name, c.reference, c.dimensions]
          .map((s) => (s || '').trim()).filter(Boolean).join(' · ');
        out.push({ name: familyName ? `${familyName} — ${componentName}` : componentName, qty, unit, subtotal: unit * qty });
      }
    } else {
      const unit = applyLineAdjustments(l.unitPrice, l.lineMarginPct, l.lineDiscountPct);
      const qty = Number(l.qty) || 0;
      out.push({
        name: [l.name, l.reference, l.dimensions].map((s) => (s || '').trim()).filter(Boolean).join(' · '),
        qty, unit, subtotal: unit * qty,
      });
    }
  }
  return out;
}

/**
 * The invoice line-items table (Producto · Cant. · Precio unit. · Subtotal) —
 * the reclaimed "ver detalle de la factura" view, now a shared presentational
 * block so the drawer and the workspace card render it identically.
 */
export function QuoteLinesTable({ invLines, currency, rates }) {
  const fmt = (v) => formatMoney(v, currency, rates);
  return (
    <div className="overflow-x-auto rounded-md border border-ink-100 bg-surface">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-ink-500 bg-ink-50 border-b border-ink-100">
            <th className="font-semibold py-1.5 px-2.5 uppercase tracking-wide text-[10px]">Producto</th>
            <th className="font-semibold py-1.5 px-2.5 text-right whitespace-nowrap uppercase tracking-wide text-[10px]">Cant.</th>
            <th className="font-semibold py-1.5 px-2.5 text-right whitespace-nowrap uppercase tracking-wide text-[10px]">Precio unit.</th>
            <th className="font-semibold py-1.5 px-2.5 text-right whitespace-nowrap uppercase tracking-wide text-[10px]">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {(invLines || []).length === 0 ? (
            <tr><td colSpan={4} className="text-center text-ink-400 py-4">Sin líneas facturables</td></tr>
          ) : invLines.map((il, i) => (
            <tr key={i} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/60 transition-colors">
              <td className="py-1.5 px-2.5 text-ink-800">{il.name || '—'}</td>
              <td className="py-1.5 px-2.5 text-right tabular-nums text-ink-700">{il.qty}</td>
              <td className="py-1.5 px-2.5 text-right tabular-nums whitespace-nowrap text-ink-700">{fmt(il.unit)}</td>
              <td className="py-1.5 px-2.5 text-right tabular-nums whitespace-nowrap font-medium text-ink-900">{fmt(il.subtotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
