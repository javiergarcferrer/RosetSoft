import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  ChevronUp, Info, Lock, RefreshCw, AlertTriangle,
  SlidersHorizontal, Download, Printer, Loader2, Share2,
} from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { clampPct, ITBIS_PCT } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';
import { baseCommissionPct, commissionBreakdown, decoratorBilling } from '../../lib/commissions.js';
import { useExchangeRatePull } from '../../lib/useExchangeRatePull.js';

/**
 * The persistent totals dock — pinned to the bottom of the screen at every
 * width, so the running total is never out of view. Replaces the old desktop
 * right-rail + the separate mobile totals bar with one responsive control.
 *
 * Anchored bottom, offset past the static sidebar on desktop via the shell's
 * `--rs-sidebar-offset` CSS variable (Layout publishes the sidebar's live width
 * — 15rem expanded, 3rem when collapsed — so the dock tracks it instead of
 * stranding a 15rem gap once the sidebar is hidden) and full-bleed on mobile
 * (where the sidebar is an off-canvas drawer). Its inner content lines up with
 * the page's `max-w-[1400px]` container so the figures sit under the columns
 * above.
 *
 * Two states:
 *   • Collapsed bar — the grand total + live DOP conversion (USD and DOP on a
 *     single line at every width) and the Share / Print / Export actions, pinned
 *     at every width. (Catálogo + Inventario live on the Artículos card, not
 *     here — duplicating them in the dock stamped a redundant pair on mobile.)
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
  onExport, exporting, onPrint, printing, onShare, sharing,
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

  // The OSMOTIC BARRIER. As a quote crosses from the CRM toward the books it
  // locks: once ACCEPTED (and certainly once a deposit is received) its total is
  // COMMITTED — the rate, discount and shipping can no longer change, or the
  // deposit and the eventual factura/asiento would no longer match. Refresh only
  // re-pulls the live rate for a STILL-OPEN quote (which follows it); an accepted
  // quote never re-prices.
  const financiallyLocked = rateLocked || !!quote.acceptedAt;
  const depositReceived = !!quote.depositReceivedAt;
  const handleRefreshRate = async () => {
    if (financiallyLocked) return;
    await refreshRate();
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
  // The rate is the order-type tier (floor 15% / special 20%); no override.
  const commissionPct = baseCommissionPct(quote);
  // Gross / net both come from the one lib breakdown so this readout and
  // Contabilidad's commission line can't drift from the payout math.
  const { gross: grossCommission, net: netCommission } = commissionBreakdown(totals, commissionPct);

  const discountPct = Number(quote.discountPct) || 0;
  const courtesyPct = Number(quote.courtesyDiscountPct) || 0;
  const shipping = Number(quote.shipping) || 0;
  // An adjustment is "active" when the dealer has set a discount, a courtesy or
  // shipping — surfaced as a dot on the collapsed button so it reads even while
  // folded.
  const hasAdjustment = discountPct > 0 || courtesyPct > 0 || shipping > 0;
  // The Friends & Family courtesy is a fixed 5% the dealer absorbs.
  const COURTESY_PCT = 5;

  const toggle = (name) => setPanel((p) => (p === name ? 'closed' : name));
  const breakdownOpen = panel === 'breakdown';

  /* ----------------------------- panel body ------------------------------ */

  // One drop-up panel, opened by tapping the total. It carries the full
  // step-by-step breakdown AND the quote adjustments (discount / shipping /
  // DOP rate), so the bottom bar itself stays a single clean row — the total
  // (USD + DOP inline) plus the Share / Export actions.
  const breakdown = (
    <div className="py-4 space-y-2">
      <Row label="Subtotal" value={fmt(totals.subtotal)} />
      {totals.marginAmt !== 0 && <Row label="Margen aplicado" value={fmt(totals.marginAmt)} muted />}
      {discountPct ? <Row label={`Descuento (${discountPct}%)`} value={`–${fmt(totals.discountAmt)}`} muted /> : null}
      {courtesyPct ? <Row label={`Cortesía amigos y familia (${courtesyPct}%)`} value={`–${fmt(totals.courtesyDiscountAmt)}`} muted /> : null}
      <Row label={`ITBIS (${ITBIS_PCT}%)`} value={`+${fmt(totals.taxAmt)}`} muted />
      {shipping ? <Row label="Envío" value={`+${fmt(totals.shipping)}`} muted /> : null}
      <div className="border-t-2 border-brand-500/20 pt-3 mt-2">
        <Row label="Total" value={totalLabel} bold />
      </div>
      {showMarginMeter && <MarginMeter marginPct={marginPct} />}
      {professional && (
        <CommissionCard
          commissionPct={commissionPct}
          grossCommission={grossCommission}
          discountAmt={totals.discountAmt}
          courtesyAmt={totals.courtesyDiscountAmt}
          netCommission={netCommission}
          fmt={fmt}
          quote={quote}
          onUpdateQuote={onUpdateQuote}
        />
      )}
      <details className="group">
        <summary className="text-[11px] text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 pt-1 min-h-6 coarse:min-h-11 cursor-pointer transition-colors">
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
          {hasAdjustment && !financiallyLocked && (
            <span className="chip bg-amber-50 text-amber-700 border border-amber-200">Aplicado</span>
          )}
          {financiallyLocked && (
            <span className="chip bg-ink-100 text-ink-600 border border-ink-200">
              <Lock size={10} /> {depositReceived ? 'Bloqueado · depósito recibido' : 'Bloqueado · aceptada'}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <div>
            <div className="label">Descuento %</div>
            <DebouncedInput
              type="number"
              min="0"
              max="100"
              className="input disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={financiallyLocked}
              value={quote.discountPct ?? 0}
              onCommit={(v) => { if (financiallyLocked) return; onUpdateQuote({ discountPct: clampPct(v) }); }}
            />
          </div>
          <div>
            <div className="label">Envío ({currency})</div>
            <DebouncedInput
              type="number"
              min="0"
              className="input disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={financiallyLocked}
              value={quote.shipping ?? 0}
              onCommit={(v) => { if (financiallyLocked) return; onUpdateQuote({ shipping: Math.max(0, Number(v) || 0) }); }}
            />
          </div>
        </div>
        {/* Friends & Family — a fixed 5% courtesy for the client. It is NOT
            drawn out of the commission like the discount above; instead it
            lowers the base the commission is computed on. */}
        <label
          className={`flex items-start gap-2.5 rounded-lg border p-3 max-w-md transition-colors ${
            financiallyLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-ink-50 active:bg-ink-100'
          } ${courtesyPct > 0 ? 'border-emerald-300 bg-emerald-50/50' : 'border-ink-200'}`}
        >
          <input
            type="checkbox"
            className="mt-0.5"
            disabled={financiallyLocked}
            checked={courtesyPct > 0}
            onChange={(e) => {
              if (financiallyLocked) return;
              onUpdateQuote({ courtesyDiscountPct: e.target.checked ? COURTESY_PCT : 0 });
            }}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">Descuento amigos y familia ({COURTESY_PCT}%)</div>
            <p className="text-[10px] text-ink-500 mt-0.5">
              Cortesía del {COURTESY_PCT}% para el cliente. No se descuenta de la comisión: esta se calcula sobre la base ya rebajada con la cortesía.
            </p>
          </div>
        </label>
        <div className="text-[10px] text-ink-500 space-y-1.5">
          <p>ITBIS fijo en {ITBIS_PCT}%. Los descuentos se aplican sobre el subtotal antes de impuestos.</p>
          <div className="flex items-center gap-2 flex-wrap">
            <span>
              {rateLocked
                ? 'Tasa DOP bloqueada al aceptar.'
                : 'Tasa DOP en vivo (Banco Popular).'}
            </span>
            <button
              type="button"
              onClick={handleRefreshRate}
              disabled={refreshingRate || financiallyLocked}
              className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-2 py-1 min-h-7 coarse:min-h-11 font-medium text-ink-700 hover:bg-ink-100 active:bg-ink-200 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              title={financiallyLocked
                ? 'La tasa quedó fija al aceptar la cotización — el total ya no puede cambiar'
                : 'Trae la tasa USD→DOP publicada hoy por Banco Popular Dominicano'}
            >
              {financiallyLocked ? (
                <><Lock size={11} /> Tasa bloqueada</>
              ) : (
                <><RefreshCw size={11} className={refreshingRate ? 'animate-spin' : ''} /> {refreshingRate ? 'Actualizando…' : 'Actualizar tasa'}</>
              )}
            </button>
          </div>
          {financiallyLocked && (
            <p>
              La tasa USD→DOP quedó fija al aceptar la cotización{depositReceived ? ' y no puede cambiar tras recibir el depósito' : ''}, para que el total cuadre con la factura y los asientos.
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

  // PORTAL TO document.body — not a flourish, the fix for the dead grey band
  // under the dock. The dock renders deep inside <main>, which is
  // overflow-y-auto; on iOS WebKit a position:fixed element inside a scroll
  // container is scoped to that container, so bottom-0 landed ABOVE the
  // home-indicator inset and the page background showed through underneath.
  // Mounted on <body> the dock is finally viewport-fixed, so bottom-0 is the
  // true physical bottom; the pb-[safe-area-inset-bottom] below then paints the
  // home-indicator strip white instead of leaving that grey gap.
  return createPortal(
    // Soft-keyboard behaviour: `kb-hide-when-open` slides the dock off-screen
    // while a line-item input out in the page is focused (so it can't cover the
    // field being typed into); `data-kb-keep` lifts the dock above the keyboard
    // instead when ITS OWN adjustment inputs (discount % / envío / courtesy) are
    // focused, so they stay visible while editing.
    // Under md the mobile ModeBar (compose / client / chat) owns the physical
    // bottom edge and the dock stacks directly above it — bottom-above-modebar
    // (index.css) is the bar's true height: 3.5rem, PLUS the home-indicator
    // inset the bar pads in an installed PWA. From md: up there is no ModeBar
    // and the dock returns to bottom-0.
    <div data-kb-keep className="fixed bottom-0 bottom-above-modebar left-0 right-0 md:left-[var(--rs-sidebar-offset,15rem)] z-30 print:hidden kb-hide-when-open">
      {/* Safe-area apron — a white fill that spills BELOW the dock to the
          physical screen edge. If iOS lays the standalone viewport SHORT (a
          legacy / cached black-translucent install, before the status-bar=black
          fix is picked up on reinstall), the home-indicator strip would
          otherwise leak the page / manifest grey under the bar. This paints it
          white WITH the dock. Off-screen (harmless) when the dock already sits
          flush at the physical bottom — Safari tabs, desktop, fresh installs. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-24 bg-surface" />
      {/* Premium elevated dock — terracotta top border, deep shadow. SOLID white
          (no translucency / backdrop-blur): a see-through dock smeared content
          behind it in the PWA. md:pb-safe-standalone fills the home-indicator
          inset with white ONLY when installed as a PWA AND the dock sits at the
          physical bottom (md+) — under md the ModeBar below the dock carries
          that inset instead, so padding here would just be dead space. */}
      <div className="border-t-[3px] border-brand-500 bg-surface shadow-pop md:pb-safe-standalone">
        <div className="max-w-[1400px] mx-auto px-4 md:px-8 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pl-8 md:pr-8">
          {/* Sliding panel — grows the dock upward (anchored at bottom). The
              grid 0fr→1fr trick animates height without a fixed pixel target. */}
          <div
            className={`grid transition-[grid-template-rows] duration-200 ease-out ${
              panel !== 'closed' ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            }`}
          >
            <div className="overflow-hidden min-h-0">
              <div className="max-h-[55vh] overflow-y-auto overflow-x-hidden border-b border-ink-100">
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
          {/* Just the row's own vertical rhythm — the home-indicator clearance
              now lives on the outer white div (pb-[safe-area-inset-bottom]),
              which both lifts this row above the pill AND paints the inset white.
              No fixed bottom pad here, so there's no double clearance. */}
          <div className="flex items-center gap-2 sm:gap-3 py-2.5">
            {/* The total leads the row — the hero figure and the breakdown
                toggle. The row wraps: amount + chevron hold the first line and
                the DOP conversion takes the second on phones; from sm: up there's
                room for everything inline (conversion tucked before the chevron
                via `order`). */}
            <button
              type="button"
              onClick={() => toggle('breakdown')}
              aria-expanded={breakdownOpen}
              className="group min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-left rounded-lg -ml-1 pl-1 pr-1 py-1 hover:bg-ink-50 transition-colors active:scale-[0.98]"
              title={breakdownOpen ? 'Ocultar desglose' : 'Ver desglose'}
            >
              {/* Eyebrow from sm: up only — on a phone the bold leading "$"
                  already reads as the total, and dropping it lets the amount and
                  its chevron hug on line one. */}
              <span className="eyebrow-xs flex-shrink-0 hidden sm:inline-block text-brand-600 font-bold tracking-widest">Total</span>
              <span className="text-2xl font-bold tabular-nums leading-none flex-shrink-0 text-ink-900 tracking-tight whitespace-nowrap">{totalLabel}</span>
              {discountPct > 0 && (
                <span className="chip bg-emerald-50 text-emerald-700 border border-emerald-200 ring-1 ring-inset ring-emerald-200/60 flex-shrink-0">−{discountPct}%</span>
              )}
              {/* Live DOP conversion. On phones `order-last w-full` parks it on
                  its own line beneath the amount (always shown, never clipped);
                  from sm: up `order-none w-auto` pulls it back inline, sitting
                  between the amount and the chevron — the desktop layout. */}
              {dopRate && currency === 'USD' && (
                <span className="order-last sm:order-none w-full sm:w-auto inline-flex min-w-0 items-center gap-1.5 text-[11px] text-ink-500 tabular-nums">
                  {/* Money never ellipsizes — the row's flex-wrap reflows it instead. */}
                  <span className="whitespace-nowrap font-medium">≈ {dopTotalLabel}</span>
                  {rateLocked ? (
                    <span className="inline-flex items-center gap-1 text-amber-600 flex-shrink-0 bg-amber-50 rounded px-1 py-0.5" title="Tasa bloqueada al aceptar · pulsa el total para actualizarla">
                      <Lock size={9} /> {dopRate.toFixed(2)}
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
                className={`text-ink-400 group-hover:text-ink-600 flex-shrink-0 transition-transform duration-200 ${breakdownOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>

            {/* Action cluster — compact icon buttons at every width (the brand
                gradient Export CTA last), pinned to the right and never shrinking.
                Ajustes moved into the drop-up panel (tap the total), which frees
                the width here to keep USD + DOP inline on one line. */}
            <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
              {/* Catálogo + Inventario are NOT here: the Artículos card carries
                  them at every width, so duplicating them in the dock just
                  stamped a redundant pair on mobile. The dock keeps only the
                  cross-cutting actions: Share / Print / Export. */}

              {/* Share the PUBLIC CLIENT LINK (the live interactive quote) via
                  the OS share sheet — the PDF stays under Exportar. Pinned at
                  every width. */}
              <DockAction
                icon={Share2}
                label="Compartir"
                onClick={onShare}
                disabled={sharing || exporting || printing}
                busy={sharing}
                ariaLabel="Compartir el enlace de la cotización"
                title="Compartir el enlace público de la cotización (Correo, WhatsApp…)"
              />

              {/* Print the PDF straight to the printer (no download). */}
              <DockAction
                icon={Printer}
                label="Imprimir"
                onClick={onPrint}
                disabled={exporting || printing || sharing}
                busy={printing}
                ariaLabel="Imprimir PDF"
                title="Imprimir directamente (sin descargar)"
              />

              {/* Export / preview the PDF — the primary action, pinned at every
                  width. Carries the terracotta brand gradient as the bar's one
                  loudest control. */}
              <DockAction
                icon={Download}
                label="Exportar"
                onClick={onExport}
                disabled={exporting || printing || sharing}
                busy={exporting}
                primary
                ariaLabel="Exportar PDF"
                title="Previsualizar y descargar PDF"
              />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Internal (dealer-only) readout of the assigned professional's commission.
 * Makes the rule visible: the regular client discount is subtracted from the
 * professional's cut, while the Friends & Family courtesy is baked into the
 * commission base (the % is computed on the post-courtesy amount). Never shown
 * to the client.
 */
function CommissionCard({ commissionPct, grossCommission, discountAmt, courtesyAmt, netCommission, fmt, quote, onUpdateQuote }) {
  const hasDiscount = discountAmt > 0;
  const hasCourtesy = courtesyAmt > 0;
  const fullyAbsorbed = hasDiscount && netCommission <= 0;
  const mode = decoratorBilling(quote);
  const trade = mode === 'trade_discount';
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50/40 p-3 space-y-2 mt-1 shadow-xs">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Comisión profesional</h3>
        <span className="eyebrow-xs text-ink-400">Interno</span>
      </div>
      {/* Gross is the % on the post-courtesy base — the courtesy already shrank
          it, so it's never shown as a separate deduction. Only the regular
          discount is drawn out dollar-for-dollar below. */}
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
          : 'El descuento al cliente saldrá de esta comisión.'}
      </p>
      {hasCourtesy && (
        <p className="text-[10px] text-ink-500">
          La cortesía amigos y familia (–{fmt(courtesyAmt)}) no se descuenta de la comisión: esta se calcula al {commissionPct}% sobre la base ya rebajada con la cortesía.
        </p>
      )}
      {/* Facturación mode — moved here from the header (internal accounting,
          dealer-only, never on the client PDF). */}
      <div className="border-t border-ink-100 pt-2 mt-2 flex items-center justify-between gap-2">
        <span className="text-sm">Facturación</span>
        <select
          value={mode}
          onChange={(e) => onUpdateQuote({ decoratorBilling: e.target.value })}
          className={`text-xs font-medium rounded-md border px-2 py-1 min-h-7 coarse:min-h-11 cursor-pointer transition-colors min-w-0 max-w-[60%] truncate ${
            trade ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-ink-200 bg-surface text-ink-700'
          }`}
          aria-label="Modalidad de facturación con el decorador"
        >
          <option value="commission">Comisión al decorador</option>
          <option value="trade_discount">Trade discount · facturar al decorador</option>
        </select>
      </div>
      {trade && (
        <p className="text-[10px] text-amber-700">
          Se factura al decorador (menos su %); no se paga comisión. No aparece en el PDF del cliente.
        </p>
      )}
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
 *   • primary (Export) — the terracotta brand-gradient CTA.
 *   • pressed — the active-panel (toggle) state, also filled.
 *   • default — bordered ghost square (hairline ink-200), the consistent
 *     enclosure the rest of the cluster shares; `dot` flags an applied
 *     adjustment, anchored to the icon's top-right.
 */
function DockAction({
  icon: Icon, label, onClick, title, ariaLabel,
  disabled, busy, pressed, primary, dot, className = '',
}) {
  // Primary carries the btn-brand SURFACE (gradient + glow) spelled out
  // explicitly — composing the `.btn-brand` class here would also drag in
  // `.btn`'s px-3/min-h geometry and fight the fixed square below.
  const tone = primary
    ? 'bg-brand-grad text-white shadow-glow hover:brightness-110 active:brightness-95'
    : pressed
      ? 'bg-ink-900 text-ink-50 border border-ink-900 shadow-sm'
      : 'text-ink-700 border border-ink-200 bg-surface hover:bg-ink-50 hover:border-ink-300 active:bg-ink-100 shadow-xs';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-pressed={pressed}
      aria-label={ariaLabel || label}
      title={title}
      className={`relative inline-flex items-center justify-center w-9 h-9 coarse:w-11 coarse:h-11 rounded-md transition-all duration-150 active:scale-[0.96] disabled:opacity-60 disabled:cursor-wait select-none ${tone} ${className}`}
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
      {dot && (
        <span
          className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ring-2 ${
            pressed ? 'bg-amber-400 ring-ink-900' : 'bg-amber-500 ring-surface'
          }`}
          aria-hidden
        />
      )}
    </button>
  );
}

function Row({ label, value, muted, bold }) {
  return (
    <div className={`flex items-baseline justify-between tabular-nums ${
      muted ? 'text-xs text-ink-500' : 'text-sm text-ink-700'
    } ${bold ? 'font-bold text-[15px] text-ink-900' : ''}`}>
      <span>{label}</span>
      <span className={`font-semibold ${bold ? 'text-brand-700' : ''}`}>{value}</span>
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
  if (quote.courtesyDiscountPct) lines.push([`– Cortesía amigos y familia ${quote.courtesyDiscountPct}%`, `–${fmt(totals.courtesyDiscountAmt)}`]);
  lines.push(['= Base imponible', fmt(totals.taxableBase)]);
  lines.push([`+ ITBIS ${ITBIS_PCT}%`, fmt(totals.taxAmt)]);
  if (totals.shipping) lines.push(['+ Envío', fmt(totals.shipping)]);
  lines.push(['= Total', fmt(totals.grandTotal)]);

  return (
    <div className="surface-subtle p-2.5 mt-2 space-y-0.5 text-[11px] tabular-nums">
      {lines.map(([l, v], i) => (
        <div key={i} className={`flex justify-between ${i === lines.length - 1 ? 'font-semibold text-ink-900 pt-1 border-t border-ink-200 mt-1' : 'text-ink-600'}`}>
          <span>{l}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
