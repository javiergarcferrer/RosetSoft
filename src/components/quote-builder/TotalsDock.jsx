import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronUp, Info, Lock, RefreshCw, AlertTriangle,
  SlidersHorizontal, X, Download, Loader2, PackageSearch,
} from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { clampPct, ITBIS_PCT } from '../../lib/pricing.js';
import { QUOTE_STATUS_DRAFT } from '../../lib/constants.js';
import { formatMoney } from '../../lib/format.js';
import { effectiveCommissionPct, commissionBreakdown } from '../../lib/commissions.js';
import { useExchangeRatePull } from '../../lib/useExchangeRatePull.js';

/**
 * The persistent totals dock — pinned to the bottom of the screen at every
 * width, so the running total is never out of view. Replaces the old desktop
 * right-rail + the separate mobile totals bar with one responsive control.
 *
 * Anchored bottom, offset past the static sidebar on desktop (`md:left-60`
 * mirrors the sidebar's `w-60`) and full-bleed on mobile (where the sidebar is
 * an off-canvas drawer). Its inner content lines up with the page's
 * `max-w-[1400px]` container so the figures sit under the columns above.
 *
 * Three states:
 *   • Collapsed bar — currency toggle, the grand total + live DOP conversion,
 *     an "Ajustes" button, and (mobile only) the Catálogo/PDF actions that live
 *     in the header on desktop. Always visible.
 *   • Breakdown — tapping the total slides up the full step-by-step total
 *     (subtotal → margin → discount → ITBIS → shipping), margin gauge,
 *     professional commission, and the "Cómo se calcula" explainer.
 *   • Adjustments — tapping "Ajustes" slides up the OPTIONAL discount card
 *     (quote-level discount % + shipping + DOP rate refresh). Hidden until
 *     clicked; an amber dot on the button flags when an adjustment is applied.
 *
 * Only one panel is open at a time. Margin lives on lines, not quote-wide, by
 * design — so a quote-wide margin gauge shows only when one is actually set.
 */
export default function TotalsDock({
  quote, totals, professional, onUpdateQuote,
  onOpenCatalog, onExport, exporting,
}) {
  const [panel, setPanel] = useState('closed'); // 'closed' | 'breakdown' | 'adjust'

  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const dopRate = rates.DOP || null;
  const dopTotal = dopRate ? totals.grandTotal * dopRate : null;
  // The rate floats live while the quote is a draft; once sent it's frozen to
  // the snapshot taken at send time (by design — a figure the client has seen
  // can't move). Flag it so a locked rate isn't mistaken for a stale one.
  const rateLocked = !!quote.status && quote.status !== QUOTE_STATUS_DRAFT;

  const { pull: refreshRate, pulling: refreshingRate, error: rateError } = useExchangeRatePull();

  const fmt = (v) => formatMoney(v, currency, rates);

  // Quote-level margin health — surfaced only when a quote-wide margin is
  // actually applied (totals.marginAmt !== 0). See <meter> rules in index.css.
  const marginPct = Number(quote.marginPct) || 0;
  const showMarginMeter = totals.marginAmt !== 0;

  // Internal commission readout — only meaningful with a professional assigned.
  const commissionPct = effectiveCommissionPct(quote);
  // Gross / net both come from the one lib breakdown so this readout and
  // Contabilidad's commission line can't drift from the payout math.
  const { gross: grossCommission, net: netCommission } = commissionBreakdown(totals, commissionPct);

  const discountPct = Number(quote.discountPct) || 0;
  const shipping = Number(quote.shipping) || 0;
  // An adjustment is "active" when the dealer has set a discount or shipping —
  // surfaced as a dot on the collapsed button so it reads even while folded.
  const hasAdjustment = discountPct > 0 || shipping > 0;

  const toggle = (name) => setPanel((p) => (p === name ? 'closed' : name));
  const breakdownOpen = panel === 'breakdown';

  /* ----------------------------- panel bodies ----------------------------- */

  const breakdown = (
    <div className="py-4 space-y-2.5">
      <Row label="Subtotal" value={fmt(totals.subtotal)} />
      {totals.marginAmt !== 0 && <Row label="Margen aplicado" value={fmt(totals.marginAmt)} muted />}
      {discountPct ? <Row label={`Descuento (${discountPct}%)`} value={`–${fmt(totals.discountAmt)}`} muted /> : null}
      <Row label={`ITBIS (${ITBIS_PCT}%)`} value={`+${fmt(totals.taxAmt)}`} muted />
      {shipping ? <Row label="Envío" value={`+${fmt(totals.shipping)}`} muted /> : null}
      <div className="border-t border-ink-100 pt-2 mt-2">
        <Row label="Total" value={fmt(totals.grandTotal)} bold />
      </div>
      {showMarginMeter && <MarginMeter marginPct={marginPct} />}
      {professional && (
        <CommissionCard
          commissionPct={commissionPct}
          grossCommission={grossCommission}
          discountAmt={totals.discountAmt}
          netCommission={netCommission}
          fmt={fmt}
        />
      )}
      <details className="group">
        <summary className="text-[11px] text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 pt-1 cursor-pointer">
          <Info size={11} />
          Cómo se calcula
        </summary>
        <BreakdownExplainer quote={quote} totals={totals} fmt={fmt} />
      </details>
    </div>
  );

  const adjust = (
    <div className="py-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">Ajustes de la cotización</h2>
        <button type="button" onClick={() => setPanel('closed')} className="btn-icon -mr-2" aria-label="Cerrar ajustes">
          <X size={16} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 max-w-md">
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
        <p>ITBIS fijo en {ITBIS_PCT}%. El descuento se aplica sobre el subtotal antes de impuestos.</p>
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
  );

  /* -------------------------------- render -------------------------------- */

  return (
    <div className="fixed bottom-0 left-0 right-0 md:left-60 z-30 print:hidden">
      <div className="border-t border-ink-200 bg-white shadow-[0_-10px_40px_-18px_rgba(0,0,0,0.25)]">
        <div className="max-w-[1400px] mx-auto px-4 md:px-8 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pl-8 md:pr-8">
          {/* Sliding panel — grows the dock upward (anchored at bottom). The
              grid 0fr→1fr trick animates height without a fixed pixel target. */}
          <div
            className={`grid transition-[grid-template-rows] duration-200 ease-out ${
              panel !== 'closed' ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            }`}
          >
            <div className="overflow-hidden min-h-0">
              <div className="max-h-[55vh] overflow-y-auto border-b border-ink-100">
                {panel === 'adjust' ? adjust : panel === 'breakdown' ? breakdown : null}
              </div>
            </div>
          </div>

          {/* Always-visible bar */}
          <div className="flex items-center gap-2 sm:gap-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
            <CurrencyToggle value={currency} onChange={(c) => onUpdateQuote({ currencyCode: c })} />

            {/* The total doubles as the breakdown toggle — a big, obvious tap
                target that slides the step-by-step total up. */}
            <button
              type="button"
              onClick={() => toggle('breakdown')}
              aria-expanded={breakdownOpen}
              className="min-w-0 flex-1 text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-ink-50 transition-colors"
              title={breakdownOpen ? 'Ocultar desglose' : 'Ver desglose'}
            >
              <div className="flex items-center gap-2">
                <span className="eyebrow-xs">Total</span>
                {discountPct > 0 && (
                  <span className="chip bg-emerald-50 text-emerald-700 border border-emerald-200">−{discountPct}%</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-lg sm:text-xl font-semibold tabular-nums truncate">{fmt(totals.grandTotal)}</span>
                <ChevronUp
                  size={16}
                  className={`text-ink-400 flex-shrink-0 transition-transform duration-200 ${breakdownOpen ? 'rotate-180' : ''}`}
                  aria-hidden
                />
              </div>
              {dopRate && currency === 'USD' && (
                <div className="text-[11px] text-ink-500 tabular-nums flex items-center gap-1 truncate">
                  ≈ RD$ {Math.round(dopTotal).toLocaleString('en-US')}
                  {rateLocked ? (
                    <span className="inline-flex items-center gap-1 text-amber-700" title="Tasa bloqueada al enviar">
                      <Lock size={10} /> @ {dopRate.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-ink-400">@ {dopRate.toFixed(2)}</span>
                  )}
                </div>
              )}
            </button>

            {/* Optional discount card — hidden until clicked. */}
            <button
              type="button"
              onClick={() => toggle('adjust')}
              aria-pressed={panel === 'adjust'}
              className={`relative inline-flex items-center gap-1.5 rounded-md px-2.5 min-h-9 coarse:min-h-11 text-sm font-medium transition-colors active:scale-[0.98] ${
                panel === 'adjust'
                  ? 'bg-ink-900 text-white'
                  : 'text-ink-700 hover:bg-ink-100 border border-ink-200'
              }`}
              title="Descuento y envío de la cotización"
            >
              <SlidersHorizontal size={16} />
              <span className="hidden sm:inline">Ajustes</span>
              {hasAdjustment && (
                <span
                  className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ring-2 ring-white ${
                    panel === 'adjust' ? 'bg-amber-400' : 'bg-amber-500'
                  }`}
                  aria-hidden
                />
              )}
            </button>

            {/* Mobile-only actions — on desktop these live in the header. */}
            <span className="md:hidden w-px h-8 bg-ink-200 mx-0.5 flex-shrink-0" aria-hidden />
            <button
              type="button"
              onClick={onOpenCatalog}
              className="md:hidden btn-icon border border-ink-200"
              aria-label="Agregar desde catálogo"
            >
              <PackageSearch size={18} />
            </button>
            <button
              type="button"
              onClick={onExport}
              disabled={exporting}
              aria-busy={exporting}
              aria-label="Exportar PDF"
              className="md:hidden btn-primary disabled:opacity-60 disabled:cursor-wait"
            >
              {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              <span>PDF</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Internal (dealer-only) readout of the assigned professional's commission.
 * Makes the rule visible: the client discount is subtracted from the
 * professional's cut, so the dealer sees exactly what the decorator earns
 * after a discount. Never shown to the client.
 */
function CommissionCard({ commissionPct, grossCommission, discountAmt, netCommission, fmt }) {
  const hasDiscount = discountAmt > 0;
  const fullyAbsorbed = hasDiscount && netCommission <= 0;
  return (
    <div className="rounded-lg border border-ink-100 bg-ink-50/60 p-3 space-y-2 mt-1">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Comisión profesional</h3>
        <span className="text-[10px] text-ink-400 uppercase tracking-wide">Interno</span>
      </div>
      <Row label={`Comisión (${commissionPct}%)`} value={fmt(grossCommission)} />
      {hasDiscount && <Row label="– Descuento al cliente" value={`–${fmt(discountAmt)}`} muted />}
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

// Quote-level margin-health gauge on the native <meter>. The browser colours
// the fill from where `value` sits against low/high/optimum: < 15% thin (rose),
// 15–40% healthy (emerald), > 40% padded (amber) — see <meter> in index.css.
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
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden flex-shrink-0">
      {['USD', 'DOP'].map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`px-2 py-1 text-[10px] font-semibold transition-colors ${
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
