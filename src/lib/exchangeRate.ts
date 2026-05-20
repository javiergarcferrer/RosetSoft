/**
 * Exchange-rate semantics for USD ↔ DOP (Dominican Peso).
 *
 * The catalog is priced in USD (Ligne Roset's official list). To quote
 * in pesos the app applies Banco Popular Dominicano's published rate.
 * The rate is pulled automatically — daily at 08:00 America/Santo_Domingo
 * by a scheduled job, plus on demand from Settings — by the `bpd-rate`
 * Edge Function, which writes the bank's compra/venta to the team
 * settings row. Nobody types it in or overrides it; the app shows the
 * bank's number as-is. We quote on the *venta* (sell) rate — what the
 * client pays to acquire USD.
 *
 * Storage note: the rate lives under `settings.bsc` (a column once used
 * for Banco Santa Cruz rates). It now holds BPD's rate; the name is just
 * a column and isn't worth a rename. `readBscRates` also reads the older
 * `settings.bpd` shape as a fallback so pre-existing data isn't lost.
 */

import { isActiveQuoteStatus } from './constants.js';
import type {
  Settings,
  BscRates,
  Quote,
  RatesMap,
} from '../types/domain.ts';

/**
 * Read the stored buy/sell record off a settings row. The shape is
 * `{ buy, sell, updatedAt }` under `settings.bsc`; legacy data under
 * `settings.bpd` is accepted as a fallback.
 */
export function readBscRates(settings: Settings | null | undefined): BscRates {
  if (!settings) return { buy: null, sell: null, updatedAt: null };
  const src = settings.bsc || settings.bpd || ({} as Partial<BscRates>);
  return {
    buy: src.buy ?? null,
    sell: src.sell ?? null,
    updatedAt: src.updatedAt ?? null,
  };
}

/**
 * Resolve the effective USD → DOP rate to apply to a quote: Banco
 * Popular's published sell (venta) rate. Falls back to buy, then to
 * 60.0, if the automatic pull hasn't landed a figure yet.
 */
export function effectiveDopRate(settings: Settings | null | undefined): number {
  const bsc = readBscRates(settings);
  return Number(bsc.sell) || Number(bsc.buy) || 60.0;
}

/** Friendly label printed on PDFs and in Settings hints. */
export function rateSourceLabel(_settings?: Settings | null): string {
  return 'Banco Popular Dominicano';
}

/**
 * Build a `formatMoney`-shaped rates map from settings, with USD as
 * the base unit (1) and DOP populated from whichever rate mode the
 * dealer picked. Use this in surfaces where the dealer expects
 * manually-entered rates to take effect immediately — the quote
 * workspace and the PDF generator — instead of the quote.rates
 * snapshot that was frozen at draft time.
 */
export function effectiveRates(settings: Settings | null | undefined): RatesMap {
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
export function displayRatesFor(
  quote: Pick<Quote, 'status' | 'rates'> | null | undefined,
  settings: Settings | null | undefined,
): RatesMap {
  if (quote && isActiveQuoteStatus(quote.status)) {
    return effectiveRates(settings);
  }
  return (quote && quote.rates) || { USD: 1 };
}
