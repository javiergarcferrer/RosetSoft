// Filing-deadline math for periodic fiscal reports — pure, jurisdiction-neutral.
//
// A periodic filing (DR: 606/607 by the 15th, IT-1 by the 20th of the FOLLOWING
// month) carries a `dueDay`. Given "now", this resolves the next deadline that
// hasn't passed and the fiscal period it covers (the month before the deadline
// month). No React, no db — a View renders it; a VM never recomputes it.

export interface FilingDeadline {
  /** Epoch ms at the end of the due day (local) — "due today" is not yet past. */
  dueAt: number;
  /** Whole calendar days from `now` to the deadline (0 = due today; never < 0). */
  daysLeft: number;
  /** The fiscal period being filed, `YYYYMM` (the month the deadline covers). */
  period: string;
}

/**
 * The next upcoming deadline for a report due on `dueDay` of the month after the
 * reported period. If this month's due day has already passed, rolls to next
 * month (and the period it covers rolls with it). Returns null for an invalid
 * `dueDay` (e.g. a non-periodic filing like per-document e-CF).
 */
export function resolveFilingDeadline(
  dueDay: number | null | undefined,
  now: number = Date.now(),
): FilingDeadline | null {
  const day = Math.trunc(Number(dueDay) || 0);
  if (day < 1 || day > 31) return null;

  const ref = new Date(now);
  const endOfDueDay = (y: number, m: number) => new Date(y, m, day, 23, 59, 59, 999).getTime();

  const y = ref.getFullYear();
  const m = ref.getMonth();
  let due = endOfDueDay(y, m);
  if (due < now) due = endOfDueDay(y, m + 1); // this month passed → next (Date normalizes overflow)

  const dueDate = new Date(due);
  // The period covered is the month BEFORE the deadline month.
  const periodDate = new Date(dueDate.getFullYear(), dueDate.getMonth() - 1, 1);
  const period = `${periodDate.getFullYear()}${String(periodDate.getMonth() + 1).padStart(2, '0')}`;

  // Calendar-day difference (date-only) so "due today" is 0, not a fractional ceil.
  const startOfToday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  const startOfDue = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate()).getTime();
  const daysLeft = Math.max(0, Math.round((startOfDue - startOfToday) / 86_400_000));

  return { dueAt: due, daysLeft, period };
}
