/**
 * Exchange-rate semantics for USD ↔ DOP (Dominican Peso).
 *
 * The catalog is priced in USD (Ligne Roset's official list). To quote
 * in pesos the app applies Banco Popular Dominicano's published rate.
 * The rate is pulled automatically — on the first app load at/after 08:00
 * each day (Santo Domingo time; see `shouldPullDailyRate`), plus on demand
 * from Settings — by the `bpd-rate` Edge Function, which writes the bank's
 * compra/venta to the team settings row. Nobody types it in or overrides
 * it; the app shows the bank's number as-is. We quote on the *venta*
 * (sell) rate — what the client pays to acquire USD.
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
 * AST (America/Santo_Domingo, UTC-4, no DST) calendar-day key for a ms
 * timestamp, e.g. "2026-05-20".
 */
function astDayKey(ms: number): string {
  return new Date(ms - 4 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * AST hour at which Banco Popular publishes the day's rate. The daily pull
 * waits for it: pulling earlier would just re-fetch yesterday's figure and
 * then mark the day done, so today's real rate would never land.
 */
const RATE_PUBLISH_HOUR_AST = 8;

/**
 * Timestamp (ms) of the most recent {@link RATE_PUBLISH_HOUR_AST}:00 AST
 * that has already passed at `now`. AST is UTC-4 with no DST, so a day is
 * exactly 24h — if `now` is still before today's 08:00 we step back a
 * whole day to yesterday's boundary.
 */
function ratePublishBoundary(now: number): number {
  // Midnight AST of now's day, expressed in UTC ms (AST midnight = 04:00Z),
  // then advanced to the publish hour.
  const astMidnightUtc = Date.parse(`${astDayKey(now)}T00:00:00.000Z`) + 4 * 3_600_000;
  const todays = astMidnightUtc + RATE_PUBLISH_HOUR_AST * 3_600_000;
  return now >= todays ? todays : todays - 86_400_000;
}

/**
 * True when the daily BPD pull should fire: the first app load at/after
 * 08:00 Santo Domingo time on a day whose post-08:00 rate hasn't been
 * captured yet (or the rate was never pulled). AppContext uses this to
 * refresh once a day without a cron — whoever opens the app first past
 * 08:00 triggers the pull, and the persisted rate serves everyone else.
 *
 * Gating on 08:00 matters: the bank publishes the new rate in the morning,
 * so a pre-08:00 login keeps yesterday's figure instead of locking in a
 * stale one and skipping the real update.
 */
export function shouldPullDailyRate(
  settings: Settings | null | undefined,
  now: number = Date.now(),
): boolean {
  const { updatedAt } = readExchangeRate(settings);
  if (!updatedAt) return true;
  return updatedAt < ratePublishBoundary(now);
}
