import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Info } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { clampPct, ITBIS_PCT } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';
import FulfillmentPills from '../FulfillmentPills.jsx';

/**
 * The persistent totals + adjustments + fulfillment rail. Always visible on
 * the right column at desktop widths so the dealer never loses sight of the
 * running total. At narrow widths the parent flips this to a full-width
 * card under the line items.
 *
 * Composition:
 *   - Totals card  (subtotal → discount → ITBIS → shipping → grand total)
 *     with a foldable "Cómo se calcula" walking through each step and an
 *     always-on DOP conversion below.
 *   - Adjustments card (quote-level discount %, shipping). Margin lives on
 *     lines, not quote-wide, by design (each line's margin reflects the
 *     deal struck on that piece).
 *   - Fulfillment card (per-quote milestones reused from container detail).
 */
export default function TotalsRail({
  quote, totals, onUpdateQuote,
}) {
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const dopRate = rates.DOP || null;
  const dopTotal = dopRate ? totals.grandTotal * dopRate : null;
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  const fmt = (v) => formatMoney(v, currency, rates);

  return (
    <div className="space-y-4">
      {/* Totals */}
      <div className="card card-pad space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Totales</h2>
          <CurrencyToggle
            value={currency}
            onChange={(c) => onUpdateQuote({ currencyCode: c })}
          />
        </div>

        <Row label="Subtotal" value={fmt(totals.subtotal)} />
        {totals.marginAmt !== 0 && (
          <Row label="Margen aplicado" value={fmt(totals.marginAmt)} muted />
        )}
        {quote.discountPct ? (
          <Row label={`Descuento (${quote.discountPct}%)`} value={`–${fmt(totals.discountAmt)}`} muted />
        ) : null}
        <Row label={`ITBIS (${ITBIS_PCT}%)`} value={`+${fmt(totals.taxAmt)}`} muted />
        {quote.shipping ? <Row label="Envío" value={`+${fmt(totals.shipping)}`} muted /> : null}
        <div className="border-t border-ink-100 pt-2 mt-2">
          <Row label="Total" value={fmt(totals.grandTotal)} bold />
        </div>
        {dopRate && currency === 'USD' && (
          <div className="text-[11px] text-ink-500 text-right tabular-nums">
            ≈ RD$ {Math.round(dopTotal).toLocaleString('en-US')}
            <span className="ml-1 text-ink-400">@ {dopRate.toFixed(2)}</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => setBreakdownOpen((v) => !v)}
          className="text-[11px] text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 pt-1"
        >
          <Info size={11} />
          Cómo se calcula
          <ChevronDown size={11} className={`transition-transform ${breakdownOpen ? 'rotate-180' : ''}`} />
        </button>
        {breakdownOpen && (
          <BreakdownExplainer quote={quote} totals={totals} fmt={fmt} />
        )}
      </div>

      {/* Adjustments */}
      <div className="card card-pad space-y-3">
        <h2 className="font-semibold text-sm">Ajustes</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="label">Descuento %</div>
            <DebouncedInput
              type="number"
              min="0"
              max="100"
              className="input"
              value={quote.discountPct ?? 0}
              onCommit={(v) => onUpdateQuote({ discountPct: clampPct(v) })}
            />
          </div>
          <div>
            <div className="label">Envío ({currency})</div>
            <DebouncedInput
              type="number"
              min="0"
              className="input"
              value={quote.shipping ?? 0}
              onCommit={(v) => onUpdateQuote({ shipping: Math.max(0, Number(v) || 0) })}
            />
          </div>
        </div>
        <p className="text-[10px] text-ink-500">
          ITBIS fijo en {ITBIS_PCT}% · La tasa DOP se gestiona en <Link to="/settings" className="underline">configuración</Link>.
        </p>
      </div>

      {/* Fulfillment */}
      <div className="card card-pad space-y-2">
        <h2 className="font-semibold text-sm">Fulfillment</h2>
        <p className="text-[11px] text-ink-500">
          Marca cada hito conforme avanza el cliente.
        </p>
        <FulfillmentPills
          quote={quote}
          onChange={(patch) => onUpdateQuote(patch)}
        />
      </div>
    </div>
  );
}

function Row({ label, value, muted, bold }) {
  return (
    <div className={`flex items-center justify-between text-sm tabular-nums ${
      muted ? 'text-ink-500' : ''
    } ${bold ? 'font-semibold text-base' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function CurrencyToggle({ value, onChange }) {
  return (
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden">
      {['USD', 'DOP'].map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${
            value === c ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-50'
          }`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

function BreakdownExplainer({ quote, totals, fmt }) {
  const lines = [];
  lines.push(['Suma de líneas', fmt(totals.subtotal)]);
  if (totals.marginAmt !== 0) lines.push(['+ Margen', fmt(totals.marginAmt)]);
  if (quote.discountPct) lines.push([`– Descuento ${quote.discountPct}%`, `–${fmt(totals.discountAmt)}`]);
  lines.push(['= Base imponible', fmt(totals.taxableBase)]);
  lines.push([`+ ITBIS ${ITBIS_PCT}%`, fmt(totals.taxAmt)]);
  if (totals.shipping) lines.push(['+ Envío', fmt(totals.shipping)]);
  lines.push(['= Total', fmt(totals.grandTotal)]);

  return (
    <div className="bg-ink-50 rounded-md p-2.5 space-y-0.5 text-[11px] tabular-nums border border-ink-100">
      {lines.map(([l, v], i) => (
        <div key={i} className={`flex justify-between ${i === lines.length - 1 ? 'font-semibold text-ink-900 pt-1 border-t border-ink-200 mt-1' : 'text-ink-600'}`}>
          <span>{l}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
