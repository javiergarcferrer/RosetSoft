import { Link } from 'react-router-dom';
import { ChevronDown, Info, Lock, RefreshCw, AlertTriangle } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { clampPct, ITBIS_PCT } from '../../lib/pricing.js';
import { QUOTE_STATUS_DRAFT } from '../../lib/constants.js';
import { formatMoney } from '../../lib/format.js';
import { effectiveCommissionPct, commissionAmount } from '../../lib/commissions.js';
import { useExchangeRatePull } from '../../lib/useExchangeRatePull.js';
/**
 * The persistent totals + adjustments rail. Always visible on the right
 * column at desktop widths so the dealer never loses sight of the running
 * total. At narrow widths the parent flips this to a full-width card
 * under the line items.
 *
 * Composition:
 *   - Totals card  (subtotal → discount → ITBIS → shipping → grand total)
 *     with a foldable "Cómo se calcula" walking through each step and an
 *     always-on DOP conversion below.
 *   - Adjustments card (quote-level discount %, shipping). Margin lives on
 *     lines, not quote-wide, by design (each line's margin reflects the
 *     deal struck on that piece).
 *
 * Fulfillment milestones used to live here as a third card; they moved to
 * the order-level status stepper (orderStages.js + OrderDetail.jsx) so the
 * lifecycle is tracked once at the operational unit, not duplicated per
 * quote.
 */
export default function TotalsRail({
  quote, totals, professional, onUpdateQuote,
}) {
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const dopRate = rates.DOP || null;
  const dopTotal = dopRate ? totals.grandTotal * dopRate : null;
  // The rate floats live while the quote is a draft; once sent it's frozen
  // to the snapshot taken at send time (by design — so a figure the client
  // has seen can't move). Flag it so the dealer doesn't mistake a locked
  // rate for a stale one after pulling a newer rate.
  const rateLocked = !!quote.status && quote.status !== QUOTE_STATUS_DRAFT;

  // On-demand BPD pull. Only offered while the rate is live (draft): once
  // sent the figure is frozen to the snapshot, so refreshing the bank's
  // rate wouldn't — and shouldn't — move it. A successful pull updates the
  // team settings row, which flows back through displayRatesFor into this
  // draft's totals automatically.
  const { pull: refreshRate, pulling: refreshingRate, error: rateError } = useExchangeRatePull();

  const fmt = (v) => formatMoney(v, currency, rates);

  // Quote-level margin health. By design most margin lives on lines, so a
  // quote-wide margin is the exception — surface the gauge only when one is
  // actually applied (totals.marginAmt !== 0). The value comes straight off
  // quote.marginPct (the input computeTotals already used to derive
  // marginAmt), so this invents no new math. The meter's low/high/optimum
  // frame a sensible target band: thin (< 15%) reads rose, healthy reads
  // emerald, padded (> 40%) reads amber — see the <meter> CSS in index.css.
  const marginPct = Number(quote.marginPct) || 0;
  const showMarginMeter = totals.marginAmt !== 0;

  // Internal commission readout — only meaningful when a professional is
  // assigned. The client discount is funded out of this commission, so we
  // show the full commission, the discount drawn from it, and the net the
  // professional actually earns. Without a professional there's no commission
  // to draw from (the dealer absorbs the discount), so the card is hidden.
  const commissionPct = effectiveCommissionPct(quote);
  const grossCommission = (totals.taxableBase + totals.discountAmt) * (commissionPct / 100);
  const netCommission = commissionAmount(totals, commissionPct);

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
            <div>
              ≈ RD$ {Math.round(dopTotal).toLocaleString('en-US')}
              {rateLocked ? (
                <span
                  className="ml-1 inline-flex items-center gap-1 rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-amber-800"
                  title="Tasa bloqueada al enviar la cotización"
                >
                  <Lock size={10} /> @ {dopRate.toFixed(2)}
                </span>
              ) : (
                <span className="ml-1 text-ink-400">@ {dopRate.toFixed(2)}</span>
              )}
            </div>
            {rateLocked && quote.sentAt && (
              <div className="text-[10px] text-amber-700 mt-0.5">
                {new Date(quote.sentAt).toLocaleDateString('es-DO')}
              </div>
            )}
          </div>
        )}

        {showMarginMeter && <MarginMeter marginPct={marginPct} />}

        <details className="group">
          <summary className="text-[11px] text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 pt-1">
            <Info size={11} />
            Cómo se calcula
            <ChevronDown size={11} className="disclosure-chevron" />
          </summary>
          <BreakdownExplainer quote={quote} totals={totals} fmt={fmt} />
        </details>
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
        <div className="text-[10px] text-ink-500 space-y-1.5">
          <p>ITBIS fijo en {ITBIS_PCT}%.</p>
          {rateLocked ? (
            <p>
              Tasa DOP bloqueada al enviar · se gestiona en{' '}
              <Link to="/settings" className="underline">configuración</Link>.
            </p>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span>Tasa DOP en vivo (Banco Popular).</span>
              <button
                type="button"
                onClick={refreshRate}
                disabled={refreshingRate}
                className="inline-flex items-center gap-1 rounded border border-ink-200 px-1.5 py-0.5 font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-60 disabled:cursor-wait"
                title="Trae la tasa USD→DOP publicada hoy por Banco Popular Dominicano"
              >
                <RefreshCw size={11} className={refreshingRate ? 'animate-spin' : ''} />
                {refreshingRate ? 'Actualizando…' : 'Actualizar tasa'}
              </button>
            </div>
          )}
          {rateError && (
            <p className="text-red-600 flex items-start gap-1">
              <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" /> {rateError}
            </p>
          )}
        </div>
      </div>

      {professional && (
        <CommissionCard
          commissionPct={commissionPct}
          grossCommission={grossCommission}
          discountAmt={totals.discountAmt}
          netCommission={netCommission}
          fmt={fmt}
        />
      )}
    </div>
  );
}

/**
 * Internal (dealer-only) readout of the assigned professional's commission.
 * Makes the rule visible: the client discount is subtracted from the
 * professional's cut, so the dealer sees exactly what the decorator earns
 * after a discount. Never shown to the client (this rail is the edit view;
 * the client preview/PDF never render commission).
 */
function CommissionCard({ commissionPct, grossCommission, discountAmt, netCommission, fmt }) {
  const hasDiscount = discountAmt > 0;
  const fullyAbsorbed = hasDiscount && netCommission <= 0;
  return (
    <div className="card card-pad space-y-2.5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">Comisión profesional</h2>
        <span className="text-[10px] text-ink-400 uppercase tracking-wide">Interno</span>
      </div>
      <Row label={`Comisión (${commissionPct}%)`} value={fmt(grossCommission)} />
      {hasDiscount && (
        <Row label="– Descuento al cliente" value={`–${fmt(discountAmt)}`} muted />
      )}
      {hasDiscount && (
        <div className="border-t border-ink-100 pt-2 mt-2">
          <Row label="Comisión neta" value={fmt(Math.max(0, netCommission))} bold />
        </div>
      )}
      <p className="text-[10px] text-ink-500">
        {hasDiscount
          ? (fullyAbsorbed
              ? 'El descuento supera la comisión: el profesional no cobra y la diferencia la absorbe la empresa.'
              : 'El descuento al cliente sale de la comisión del profesional.')
          : 'Cualquier descuento al cliente saldrá de esta comisión.'}
      </p>
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

// Quote-level margin-health gauge built on the native <meter>. The browser
// colours the fill from where `value` sits against low/high/optimum, so the
// band itself is the legend: < 15% thin (rose), 15–40% healthy (emerald),
// > 40% padded (amber) — see the <meter> rules in index.css. `value` clamps
// to [min,max], so a negative (loss-leader) margin reads as thin, as intended.
function MarginMeter({ marginPct }) {
  return (
    <div className="space-y-1 pt-0.5">
      <div className="flex items-center justify-between text-[10px] text-ink-500">
        <span className="eyebrow-xs">Margen</span>
        <span className="tabular-nums text-ink-700 font-medium">{marginPct}%</span>
      </div>
      <meter
        className="w-full"
        min={0}
        max={60}
        low={15}
        high={40}
        optimum={27}
        value={Math.max(0, Math.min(60, marginPct))}
        aria-label={`Margen aplicado ${marginPct}%`}
        title={`Margen aplicado: ${marginPct}%`}
      />
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
    <div className="bg-ink-50 rounded-md p-2.5 mt-2 space-y-0.5 text-[11px] tabular-nums border border-ink-100">
      {lines.map(([l, v], i) => (
        <div key={i} className={`flex justify-between ${i === lines.length - 1 ? 'font-semibold text-ink-900 pt-1 border-t border-ink-200 mt-1' : 'text-ink-600'}`}>
          <span>{l}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
