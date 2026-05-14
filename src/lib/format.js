/**
 * Format a numeric amount as currency.
 *
 *  - `value` is in the base currency (USD, since the price list is in USD).
 *  - `rates` map = { USD: 1, DOP: 60.0, ... } — value × rate gives display amount.
 *  - DOP uses the local "RD$ 1,234" style (whole pesos).
 */
export function formatMoney(value, code = 'USD', rates = { USD: 1, DOP: 60.0 }) {
  if (value == null || Number.isNaN(value)) return '—';
  const rate = rates?.[code] ?? 1;
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

/** Short form — no currency symbol, just the rounded number. */
export function formatMoneyShort(value, code = 'USD', rates = { USD: 1, DOP: 60.0 }) {
  if (value == null || Number.isNaN(value)) return '—';
  const rate = rates?.[code] ?? 1;
  const converted = value * rate;
  return code === 'DOP'
    ? Math.round(converted).toLocaleString('en-US')
    : converted.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
