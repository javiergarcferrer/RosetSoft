/**
 * Shared cycle math for the monthly commissions payout.
 *
 * The dealer pays out on the 15th of each month, covering a cycle that
 * runs from the 16th of the previous month through the 15th of the
 * current month. Both the admin/Commissions report and the accounting
 * /accounting/commissions read-only mirror consume this — keeping the
 * math here so the two surfaces stay in lockstep.
 */

/**
 * Returns the cycle that *ends* `offsetMonths` months from the current
 * 15th. offset=0 = "active cycle"; offset=-1 = "previous cycle".
 *
 * The active cycle runs from the 16th of the prior month through the
 * 15th of "this" month — where "this" month is the next 15th still
 * coming. Before the 15th, "this" is the current calendar month;
 * from the 16th onward, "this" rolls forward.
 */
export function cycleEnding(now, offsetMonths) {
  const day = now.getDate();
  const baseEndMonth = day <= 15 ? now.getMonth() : now.getMonth() + 1;
  const endMonth = baseEndMonth + offsetMonths;
  const year = now.getFullYear();
  const end   = new Date(year, endMonth, 15, 23, 59, 59, 999);
  const start = new Date(year, endMonth - 1, 16, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

export function isoDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISODate(iso, endOfDay = false) {
  if (!iso) return Date.now();
  const [y, m, d] = iso.split('-').map(Number);
  const date = endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  return date.getTime();
}

export function formatCycle({ start, end }) {
  const opts = { day: 'numeric', month: 'short' };
  const s = new Date(start).toLocaleDateString('es-DO', opts);
  const e = new Date(end).toLocaleDateString('es-DO', opts);
  const year = new Date(end).getFullYear();
  return `${s} — ${e}, ${year}`;
}

export function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}
