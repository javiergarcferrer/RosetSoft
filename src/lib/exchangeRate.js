/**
 * Exchange-rate semantics for USD ↔ DOP (Dominican Peso).
 *
 * The dealer is a Banco Santa Cruz customer; the rate they actually
 * receive on a wire / a card transaction is the BSC rate, not the
 * international "market" reference from an aggregator. So the data
 * model now holds BSC's published buy/sell rates and the UI is built
 * around the dealer keeping them current.
 *
 * BSC's website (bsc.com.do) is a Nuxt SPA — no public JSON endpoint
 * we can fetch from the browser without auth + CORS. The dealer keeps
 * the rate fresh by hand (the BSC mobile app shows it on every login)
 * and types it into Settings → "Tasa de cambio". A `BSC_PUBLIC_URL`
 * constant points the Settings card at bsc.com.do/divisas for a
 * one-tap reference; the rate value itself is dealer-entered.
 *
 * Modes
 * -----
 *   bsc-buy    BSC's published buy rate (the rate BSC pays to acquire
 *              USD from a holder — i.e. the rate the dealer receives
 *              when converting customer DOP into USD revenue).
 *   bsc-sell   BSC's published sell rate (the rate the customer pays
 *              to acquire USD). Higher than buy.
 *   custom     A free-form override the dealer types in directly.
 *              Used when negotiating a specific deal or applying a
 *              corporate rate that differs from BSC's retail screen.
 *
 * Backwards-compatibility: rows in `settings` that still carry the
 * old `bpd` shape and `dopRateMode: 'bpd-buy' | 'bpd-sell' | 'market'`
 * are read transparently — bsc fields fall back to bpd, and the
 * legacy 'bpd-*' / 'market' modes resolve to a best-equivalent bsc
 * rate. New writes always use the bsc shape.
 */

import { isActiveQuoteStatus } from './constants.js';

export const BSC_PUBLIC_URL = 'https://www.bsc.com.do/divisas';

/**
 * Read BSC's buy/sell record off a settings row. The shape is
 * `{ buy, sell, updatedAt }`; legacy data under `settings.bpd` is
 * accepted as a fallback so existing dealer accounts don't suddenly
 * lose their stored rate when this code ships.
 */
export function readBscRates(settings) {
  if (!settings) return { buy: null, sell: null, updatedAt: null };
  const src = settings.bsc || settings.bpd || {};
  return {
    buy: src.buy ?? null,
    sell: src.sell ?? null,
    updatedAt: src.updatedAt ?? null,
  };
}

/**
 * Resolve the effective USD → DOP rate to apply to a quote, based on
 * the dealer's selected mode. Returns a number; defaults to 60.0 if
 * the chosen rate isn't set yet.
 *
 * Legacy modes:
 *   bpd-buy / bpd-sell → mapped to bsc-buy / bsc-sell
 *   market             → mapped to bsc-sell (the conservative pick
 *                        for retail quoting; sell > buy, so quoting
 *                        in sell maximizes the dealer's USD invoice)
 */
export function effectiveDopRate(settings) {
  if (!settings) return 60.0;
  const mode = normalizeRateMode(settings.dopRateMode);
  const bsc = readBscRates(settings);
  switch (mode) {
    case 'bsc-buy':  return Number(bsc.buy)  || Number(bsc.sell) || 60.0;
    case 'bsc-sell': return Number(bsc.sell) || Number(bsc.buy)  || 60.0;
    case 'custom':   return Number(settings.currencyRates?.DOP) || 60.0;
    default:         return Number(bsc.sell) || Number(bsc.buy) || 60.0;
  }
}

/** Friendly label printed on PDFs and in Settings hints. */
export function rateSourceLabel(settings) {
  const mode = normalizeRateMode(settings?.dopRateMode);
  switch (mode) {
    case 'bsc-buy':  return 'Banco Santa Cruz — tasa de compra';
    case 'bsc-sell': return 'Banco Santa Cruz — tasa de venta';
    case 'custom':   return 'Tasa personalizada';
    default:         return 'Banco Santa Cruz';
  }
}

/**
 * Coerce legacy / unset rate-mode values into the current vocabulary.
 * Any unknown / empty value falls through to 'bsc-sell' as the safe
 * retail default.
 */
function normalizeRateMode(mode) {
  switch (mode) {
    case 'bsc-buy':
    case 'bpd-buy':       return 'bsc-buy';
    case 'bsc-sell':
    case 'bpd-sell':
    case 'market':        return 'bsc-sell';
    case 'custom':        return 'custom';
    default:              return 'bsc-sell';
  }
}

/**
 * Build a `formatMoney`-shaped rates map from settings, with USD as
 * the base unit (1) and DOP populated from whichever rate mode the
 * dealer picked. Use this in surfaces where the dealer expects
 * manually-entered rates to take effect immediately — the quote
 * workspace and the PDF generator — instead of the quote.rates
 * snapshot that was frozen at draft time.
 */
export function effectiveRates(settings) {
  return { USD: 1, DOP: effectiveDopRate(settings) };
}

/**
 * Rates to use when displaying totals for a specific quote on list /
 * detail surfaces (Quotes, Orders, OrderDetail, Dashboard,
 * CustomerDetail, ProfessionalDetail, AcceptedQuotes, etc.).
 *
 * Rule of thumb:
 *   • Active quotes (draft / sent) → live rates from settings.
 *     The dealer is still working with the customer; the figure in
 *     the list should match what the workspace shows.
 *   • Finalised quotes (accepted / declined / archived) → the
 *     snapshot the quote was finalised with. The rate quoted to that
 *     customer is the historical record; today's rate would
 *     misrepresent what the customer agreed to.
 *
 * Falls back to USD-only when both sides are missing so formatMoney
 * still has a valid map to read.
 */
export function displayRatesFor(quote, settings) {
  if (quote && isActiveQuoteStatus(quote.status)) {
    return effectiveRates(settings);
  }
  return (quote && quote.rates) || { USD: 1 };
}
