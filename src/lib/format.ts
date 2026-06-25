/**
 * Format a numeric amount as currency.
 *
 *  - `value` is in the base currency (USD, since the price list is in USD).
 *  - `rates` map = { USD: 1, DOP: 60.0, ... } — value × rate gives display amount.
 *  - DOP uses the local "RD$ 1,234" style (whole pesos).
 */

import type { CurrencyCode, RatesMap } from '../types/domain.ts';

const DEFAULT_RATES: RatesMap = { USD: 1, DOP: 60.0 };

export function formatMoney(
  value: number | null | undefined,
  code: CurrencyCode | string = 'USD',
  rates: RatesMap | Record<string, number> = DEFAULT_RATES,
): string {
  if (value == null || Number.isNaN(value)) return '—';
  const rate = (rates as Record<string, number | undefined>)?.[code] ?? 1;
  const converted = value * rate;
  if (code === 'DOP') {
    const rounded = Math.round(converted);
    return `RD$ ${rounded.toLocaleString('en-US')}`;
  }
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(converted);
  } catch {
    return `${converted.toFixed(2)} ${code}`;
  }
}

/**
 * Format a percentage for display — strips floating-point noise.
 *
 * Discounts/margins are often *computed* (list-vs-net ratios, margin factors),
 * so a stored value can carry the full float tail — 63.636298932384335 instead
 * of a clean 63.64. Rounds to at most 2 decimals and drops trailing zeros, so
 * 10 stays "10" while 63.636298932384335 reads "63.64". The caller owns the %
 * sign and any +/- prefix (a negative value keeps its own "-").
 */
export function formatPct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '0';
  return String(Number(Number(value).toFixed(2)));
}

/**
 * Format an amount ALREADY expressed in DOP — no rate conversion. The ledger
 * and financial statements are booked in the fiscal/functional currency (DOP),
 * unlike `formatMoney`, which converts a USD base by the live rate. Two
 * decimals (cents), "RD$ 1,234.56".
 */
export function formatDop(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `RD$ ${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
