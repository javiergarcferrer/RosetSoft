import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronUp, Info, Lock, RefreshCw, AlertTriangle,
  SlidersHorizontal, Download, Loader2, PackageSearch, Share2,
} from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { clampPct, ITBIS_PCT } from '../../lib/pricing.js';
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
 * Two states:
 *   • Collapsed bar — the grand total + live DOP conversion (USD and DOP on a
 *     single line at every width) and the Share + Export PDF actions, pinned at
 *     every width (Catálogo rides along on mobile, where the header hides it).
 *     Always visible.
 *   • Open panel — tapping the total slides up the full step-by-step total
 *     (subtotal → margin → discount → ITBIS → shipping), margin gauge,
 *     professional commission, the "Cómo se calcula" explainer, AND the quote
 *     adjustments (discount % + shipping + DOP rate refresh). Folding the
 *     adjustments in here is what frees the collapsed bar to stay a single
 *     clean line.
 *
 * Margin lives on lines, not quote-wide, by
 * design — so a quote-wide margin gauge shows only when one is actually set.
 */
export default function TotalsDock({
  quote, rateLocked, totals, totalsRange, professional, onUpdateQuote,
  onOpenCatalog, onExport, exporting, onShare, sharing,
}) {
  const [panel, setPanel] = useState('closed'); // 'closed' | 'breakdown'

  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const dopRate = rates.DOP || null;
  const dopTotal = dopRate ? totals.grandTotal * dopRate : null;
  // `rateLocked` is the shared rate-lock state (lib/exchangeRate:quoteRateState),
  // resolved once in QuoteBuilder and passed in — never re-derived here, so this
  // padlock can't disagree with the priced figure.

  const { pull: refreshRate, pulling: refreshingRate, error: rateError } = useExchangeRatePull();

  // Pull today's published rate and apply it. Before accept the quote tracks the
  // live settings rate, so refreshing settings is enough — the figure follows.
  // On an ACCEPTED quote the rate is a frozen snapshot (quote.rates); refreshing
  // writes the new rate straight onto THIS quote, deliberately re-pricing it at
  // today's number (the one case where a committed figure is allowed to move,
  // because the dealer asked for it).
  const handleRefreshRate = async () => {
    const next = await refreshRate();
    if (rateLocked && next && typeof next === 'object' && next.DOP) {
      onUpdateQuote({ rates: next });
    }
  };

  const fmt = (v) => formatMoney(v, currency, rates);
  // Range twin of the grand total — while any priced line is quoted by range
  // (material-less), the total reads "min – max" and the DOP approx widens too.
  // Collapses to the single figure the moment every line carries a real price.
  const hasRange = !!totalsRange && totalsRange.max > totalsRange.min;
  const totalLabel = hasRange ? `${fmt(totalsRange.min)} – ${fmt(totalsRange.max)}` : fmt(totals.grandTotal);
  const dopTotalLabel = dopRate
    ? (hasRange
        ? `RD$ ${Math.round(totalsRange.min * dopRate).toLocaleString('en-US')} – ${Math.round(totalsRange.max * dopRate).toLocaleString('en-US')}`
        : `RD$ ${Math.round(dopTotal).toLocaleString('en-US')}`)
    : null;

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

  /* ----------------------------- panel body ------------------------------ */

  // One drop-up panel, opened by tapping the total. It carries the full
  // step-by-step breakdown AND the quote adjustments (discount / shipping /
  // DOP rate), so the bottom bar itself stays a single clean row — the total
  // (USD + DOP inline) plus the Share / Export actions.
  const breakdown = (
    <div className="py-4 space-y-2.5">
      <Row label="Subtotal" value={fmt(totals.subtotal)} />
      {totals.marginAmt !== 0 && <Row label="Margen aplicado" value={fmt(totals.marginAmt)} muted />}
      {discountPct ? <Row label={`Descuento (${discountPct}%)`} value={`–${fmt(totals.discountAmt)}`} muted /> : null}
      <Row label={`ITBIS (${ITBIS_PCT}%)`} value={`+${fmt(totals.taxAmt)}`} muted />
      {shipping ? <Row label="Envío" value={`+${fmt(totals.shipping)}`} muted /> : null}
      <div className="border-t border-ink-100 pt-2 mt-2">
        <Row label="Total" value={totalLabel} bold />
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

      {/* Adjustments — discount %, shipping, and the DOP rate. Lives in the
          panel (not a separate bar button) so the dock's collapsed row stays a
          single clean line. */}
      <div className="border-t border-ink-100 pt-3 mt-1 space-y-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={13} className="text-ink-500" />
          <h2 className="font-semibold text-sm">Ajustes de la cotización</h2>
          {hasAdjustment && (
            <span className="chip bg-amber-50 text-amber-700 border border-amber-200">Aplicado</span>
          )}
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
          <div className="flex items-center gap-2 flex-wrap">
            <span>
              {rateLocked
                ? 'Tasa DOP bloqueada al aceptar.'
                : 'Tasa DOP en vivo (Banco Popular).'}
            </span>
            <button
              type="button"
              onClick={handleRefreshRate}
              disabled={refreshingRate}
              className="inline-flex items-center gap-1 rounded border border-ink-200 px-1.5 py-0.5 font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-60 disabled:cursor-wait"
              title={rateLocked
                ? 'Trae la tasa USD→DOP de hoy (Banco Popular) y reprecia esta cotización con ella'
                : 'Trae la tasa USD→DOP publicada hoy por Banco Popular Dominicano'}
            >
              <RefreshCw size={11} className={refreshingRate ? 'animate-spin' : ''} />
              {refreshingRate
                ? 'Actualizando…'
                : rateLocked ? 'Actualizar tasa de hoy' : 'Actualizar tasa'}
            </button>
          </div>
          {rateLocked && (
            <p>
              Al actualizar se reprecia esta cotización con la tasa de hoy. La tasa la gestiona{' '}
              <Link to="/settings" className="underline">configuración</Link>.
            </p>
          )}
          {rateError && (
            <p className="text-red-600 flex items-start gap-1">
              <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" /> {rateError}
            </p>
          )}
        </div>
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
                {panel === 'breakdown' ? breakdown : null}
              </div>
            </div>
          </div>

          {/* Always-visible bar: the running total (eyebrow · USD amount · live
              DOP conversion · chevron) then the Share / Export icon cluster. With
              Ajustes folded into the drop-up panel only Share + Export (+ Añadir
              on phones) remain here. On wide screens USD and DOP read on a single
              line, matching the desktop reference; on a narrow phone — where a
              five-figure USD, a seven-figure DOP and the touch icons can't all
              share one line — the DOP conversion wraps to its own line just
              beneath the amount, so it's always shown in full, never clipped. */}
          <div className="flex items-center gap-2 sm:gap-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {/* The total leads the row — the hero figure and the breakdown
                toggle. The row wraps: amount + chevron hold the first line and
                the DOP conversion takes the second on phones; from sm: up there's
                room for everything inline (conversion tucked before the chevron
                via `order`). */}
            <button
              type="button"
              onClick={() => toggle('breakdown')}
              aria-expanded={breakdownOpen}
              className="group min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-left rounded-lg -ml-1 pl-1 pr-1 py-1 hover:bg-ink-50 transition-colors"
              title={breakdownOpen ? 'Ocultar desglose' : 'Ver desglose'}
            >
              {/* Eyebrow from sm: up only — on a phone the bold leading "$"
                  already reads as the total, and dropping it lets the amount and
                  its chevron hug on line one. */}
              <span className="eyebrow-xs flex-shrink-0 hidden sm:inline-block">Total</span>
              <span className="text-lg sm:text-xl font-semibold tabular-nums leading-none flex-shrink-0">{totalLabel}</span>
              {discountPct > 0 && (
                <span className="chip bg-emerald-50 text-emerald-700 border border-emerald-200 flex-shrink-0">−{discountPct}%</span>
              )}
              {/* Live DOP conversion. On phones `order-last w-full` parks it on
                  its own line beneath the amount (always shown, never clipped);
                  from sm: up `order-none w-auto` pulls it back inline, sitting
                  between the amount and the chevron — the desktop layout. */}
              {dopRate && currency === 'USD' && (
                <span className="order-last sm:order-none w-full sm:w-auto inline-flex min-w-0 items-center gap-1 text-[11px] text-ink-500 tabular-nums">
                  <span className="truncate">≈ {dopTotalLabel}</span>
                  {rateLocked ? (
                    <span className="inline-flex items-center gap-1 text-amber-700 flex-shrink-0" title="Tasa bloqueada al aceptar · pulsa el total para actualizarla">
                      <Lock size={10} /> @ {dopRate.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-ink-400 flex-shrink-0">@ {dopRate.toFixed(2)}</span>
                  )}
                </span>
              )}
              {/* Hugs the figure (no ml-auto) so the toggle reads as part of the
                  price. On phones the conversion's `order-last` jumps past it to
                  line two, keeping the chevron on the amount's line; on desktop
                  it trails the conversion inline. */}
              <ChevronUp
                size={16}
                className={`text-ink-400 flex-shrink-0 transition-transform duration-200 ${breakdownOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>

            {/* Action cluster — compact icon buttons at every width (the filled
                Export CTA last), pinned to the right and never shrinking.
                Ajustes moved into the drop-up panel (tap the total), which frees
                the width here to keep USD + DOP inline on one line. */}
            <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
              {/* Catálogo — phone/tablet only; the header and items card carry it
                  on desktop. */}
              <DockAction
                icon={PackageSearch}
                label="Añadir"
                onClick={onOpenCatalog}
                ariaLabel="Agregar desde catálogo"
                title="Agregar desde catálogo"
                className="md:hidden"
              />

              {/* Share an interactive client link — pinned at every width. */}
              <DockAction
                icon={Share2}
                label="Compartir"
                onClick={onShare}
                disabled={sharing}
                busy={sharing}
                ariaLabel="Compartir enlace para el cliente"
                title="Copiar un enlace interactivo para el cliente"
              />

              {/* Export / preview the PDF — the primary action, pinned at every
                  width. */}
              <DockAction
                icon={Download}
                label="Exportar"
                onClick={onExport}
                disabled={exporting}
                busy={exporting}
                primary
                ariaLabel="Exportar PDF"
                title="Previsualizar y descargar PDF"
              />
            </div>
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

/**
 * One action in the dock's toolbar — a single compact icon button at every
 * width, matching the desktop dock's aesthetic: a 9×9 square (11×11 on coarse
 * pointers, per Apple HIG / WCAG 2.5.5), label carried by the tooltip /
 * accessible name rather than visible text so the whole bar stays on one row.
 * Every button is the same rounded square so the cluster reads as one even,
 * deliberate rhythm:
 *   • primary (Export) — the filled ink-900 CTA.
 *   • pressed — the active-panel (toggle) state, also filled.
 *   • default — bordered ghost square (hairline ink-200), the consistent
 *     enclosure the rest of the cluster shares; `dot` flags an applied
 *     adjustment, anchored to the icon's top-right.
 */
function DockAction({
  icon: Icon, label, onClick, title, ariaLabel,
  disabled, busy, pressed, primary, dot, className = '',
}) {
  const tone = primary
    ? 'bg-ink-900 text-white border border-ink-900 hover:bg-ink-800 active:bg-ink-700'
    : pressed
      ? 'bg-ink-900 text-white border border-ink-900'
      : 'text-ink-700 border border-ink-200 hover:bg-ink-100 hover:border-ink-300 active:bg-ink-200';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-pressed={pressed}
      aria-label={ariaLabel || label}
      title={title}
      className={`relative inline-flex items-center justify-center w-9 h-9 coarse:w-11 coarse:h-11 rounded-lg transition-colors active:scale-[0.96] disabled:opacity-60 disabled:cursor-wait ${tone} ${className}`}
    >
      {busy ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
      {dot && (
        <span
          className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ring-2 ${
            pressed ? 'bg-amber-400 ring-ink-900' : 'bg-amber-500 ring-white'
          }`}
          aria-hidden
        />
      )}
    </button>
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
