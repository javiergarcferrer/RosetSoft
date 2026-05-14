/**
 * Exchange-rate fetching for USD ↔ DOP (Dominican Peso).
 *
 * BPD (Banco Popular Dominicano) doesn't expose a public no-auth endpoint that
 * works with CORS from a browser, so we use two complementary sources:
 *
 *   1. **Market reference rate** — fetched live from open.er-api.com (free, CORS,
 *      no key). This is a good fallback and gives a date-stamped "market" rate.
 *   2. **Banco Popular Dominicano rate** — entered manually from
 *      https://popularenlinea.com (or the BPD mobile app). User can store buy
 *      and sell rates. The sell rate is what a customer typically pays to
 *      acquire USD; in retail quoting we use the buy rate (the bank's buy =
 *      what we'd receive when converting customer's DOP to USD invoice).
 *
 * In `settings.currencyRates` we keep `{ USD: 1, DOP: <rate> }` plus extended
 * fields under `settings.bpd` and `settings.market`.
 */

const MARKET_URL = 'https://open.er-api.com/v6/latest/USD';

/**
 * Fetch the latest USD → DOP market rate from open.er-api.com.
 *
 *   @returns { rate: number, date: string, source: string } | null
 */
export async function fetchMarketRate() {
  try {
    const res = await fetch(MARKET_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data?.result !== 'success' || !data?.rates?.DOP) {
      throw new Error('Unexpected payload: ' + JSON.stringify(data).slice(0, 100));
    }
    return {
      rate: data.rates.DOP,
      date: data.time_last_update_utc || new Date().toUTCString(),
      source: 'open.er-api.com',
    };
  } catch (err) {
    console.warn('Market rate fetch failed:', err.message);
    return null;
  }
}

/**
 * Build a `currencyRates` map from the active rate setting on settings.
 * The user can choose which rate type they want to apply.
 *
 *   modes: 'bpd-buy' | 'bpd-sell' | 'market' | 'custom'
 */
export function effectiveDopRate(settings) {
  if (!settings) return 60.0; // fallback
  const mode = settings.dopRateMode || 'bpd-sell';
  const bpd = settings.bpd || {};
  const market = settings.market || {};
  switch (mode) {
    case 'bpd-buy': return Number(bpd.buy) || Number(market.rate) || 60.0;
    case 'bpd-sell': return Number(bpd.sell) || Number(market.rate) || 60.0;
    case 'market': return Number(market.rate) || Number(bpd.sell) || 60.0;
    case 'custom': return Number(settings.currencyRates?.DOP) || 60.0;
    default: return Number(bpd.sell) || Number(market.rate) || 60.0;
  }
}

/** Return what label to print on the quote PDF and in UI hints. */
export function rateSourceLabel(settings) {
  const mode = settings?.dopRateMode || 'bpd-sell';
  switch (mode) {
    case 'bpd-buy': return 'BPD tasa de compra';
    case 'bpd-sell': return 'BPD tasa de venta';
    case 'market': return `Tasa de mercado (${settings?.market?.source || 'open.er-api.com'})`;
    case 'custom': return 'Tasa personalizada';
    default: return 'BPD';
  }
}

export const BPD_PUBLIC_URL = 'https://popularenlinea.com';
