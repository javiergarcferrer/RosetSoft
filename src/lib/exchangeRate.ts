/**
 * Exchange-rate semantics for USD ↔ DOP (Dominican Peso).
 *
 * The catalog is priced in USD (Ligne Roset's official list). To quote
 * in pesos the app applies Banco Popular Dominicano's published rate — a
 * single value the bank fixes each morning (~08:30 AST) for the whole day.
 * The `bpd-rate` Edge Function fetches it and writes the bank's compra/venta
 * to the team settings row. Nobody types it in or overrides it; the app shows
 * the bank's number as-is. We quote on the *venta* (sell) rate — what the
 * client pays to acquire USD.
 *
 * Reliability is server-side: a pg_cron job pulls hourly across the DR
 * business day (migration *_bpd_rate_cron_hourly), so the bank's once-a-day
 * publish always lands even if it runs a little late or a single attempt fails
 * — re-pulling a fixed daily rate is idempotent. The browser session-pull
 * below (`shouldPullSessionRate`) and the on-demand Settings button are layered
 * on top only for instant refresh + to bootstrap the cron on a fresh deploy.
 *
 * Storage note: the rate lives under `settings.exchangeRate`. The column
 * was renamed `bsc` (Banco Santa Cruz) → `exchange_rate` once the source
 * became Banco Popular; `readExchangeRate` still reads the legacy `bsc` /
 * `bpd` shapes as fallbacks so pre-existing data isn't lost.
 */

import type {
  Settings,
  ExchangeRate,
  Quote,
  RatesMap,
} from '../types/domain.ts';

/**
 * Read the stored buy/sell record off a settings row. The shape is
 * `{ buy, sell, updatedAt }` under `settings.exchangeRate`; legacy
 * `settings.bsc` / `settings.bpd` shapes are accepted as fallbacks.
 */
export function readExchangeRate(settings: Settings | null | undefined): ExchangeRate {
  if (!settings) return { buy: null, sell: null, updatedAt: null };
  const src = settings.exchangeRate || settings.bsc || settings.bpd || ({} as Partial<ExchangeRate>);
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
  const rate = readExchangeRate(settings);
  return Number(rate.sell) || Number(rate.buy) || 60.0;
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
 * THE single source of truth for a quote's exchange-rate lock: the rate map to
 * price / display with, AND whether it's frozen. Every surface derives from this
 * one function — the totals-dock padlock, the list/detail figures, the PDF, the
 * public link — instead of re-deriving the condition, so the lock can never read
 * one way in one place and another way somewhere else (the bug class this
 * replaces).
 *
 *   • locked === false → not yet accepted (draft / sent / declined). `rates`
 *     floats with today's live Banco Popular venta from settings.
 *   • locked === true  → accepted. `rates` is the snapshot frozen the instant
 *     the quote was accepted (`acceptedAt`); it can't move under the client.
 *
 * The accept-time snapshot itself is written once by useQuoteController on the
 * accept transition; this function only READS the resulting state.
 */
export interface QuoteRateState {
  /** Frozen to the accept-time snapshot? */
  locked: boolean;
  /** The rate map to price / display this quote with (snapshot when locked, else live). */
  rates: RatesMap;
  /** Convenience: the USD→DOP figure in `rates` (null when absent). */
  dopRate: number | null;
}

export function quoteRateState(
  quote: Pick<Quote, 'rates' | 'acceptedAt'> | null | undefined,
  settings: Settings | null | undefined,
): QuoteRateState {
  const locked = !!(quote && quote.acceptedAt && quote.rates);
  const rates = locked ? (quote!.rates as RatesMap) : effectiveRates(settings);
  return { locked, rates, dopRate: rates?.DOP ?? null };
}

/** The rate map to price / display a quote with — `.rates` of {@link quoteRateState}. */
export function displayRatesFor(
  quote: Pick<Quote, 'rates' | 'acceptedAt'> | null | undefined,
  settings: Settings | null | undefined,
): RatesMap {
  return quoteRateState(quote, settings).rates;
}

/**
 * Minimum gap between two automatic pulls. The rate is refreshed on every
 * app session so today's figure always lands — but a logged-in dealer who
 * reloads the app a few times in a row (or React StrictMode's double mount
 * in dev) shouldn't hammer the bank's rate-limited API for a number that
 * only changes once each morning. A genuine new session past this window
 * re-pulls; rapid reloads inside it reuse the figure just fetched.
 */
const SESSION_RATE_THROTTLE_MS = 30 * 60_000; // 30 minutes

/**
 * True when the browser session-pull should fire for this app session. This is
 * NOT the reliability mechanism — the server-side hourly cron is (see the
 * file header). It's layered on top for two things: instant refresh when a
 * dealer opens the app, and bootstrapping the cron on a fresh deploy (a
 * migration can't know the project URL + service key, so the first authenticated
 * invoke arms the schedule).
 *
 * It pulls when the rate was never fetched, and otherwise whenever the stored
 * figure is older than {@link SESSION_RATE_THROTTLE_MS}. The bank publishes one
 * rate each morning, so an early pull simply re-fetches the same number; it's
 * idempotent. No 08:00 gate, no once-per-day marker to miss.
 */
export function shouldPullSessionRate(
  settings: Settings | null | undefined,
  now: number = Date.now(),
): boolean {
  const { updatedAt } = readExchangeRate(settings);
  if (!updatedAt) return true;
  return now - updatedAt >= SESSION_RATE_THROTTLE_MS;
}
