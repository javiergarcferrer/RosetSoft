/**
 * "hace 2s", "hace 1m", "hace 3h", "hace 5d" — for save-indicator and
 * activity stamps where the precise time is less important than the recency.
 *
 * Spanish strings inline (es-DO locale, no i18n library).
 */
export function relativeFromNow(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d}d`;
  return new Date(ts).toLocaleDateString('es-DO', { day: 'numeric', month: 'short' });
}
