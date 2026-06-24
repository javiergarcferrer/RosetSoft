/**
 * Recurring transactions Model — the schedule math + the concrete transaction a
 * template materializes. Pure: no React, no Supabase.
 *
 * A template fires on a cadence (weekly/monthly/yearly × interval) anchored on
 * its `startAt` (so a monthly bill keeps its day-of-month, clamped on short
 * months). Generation stays human-in-the-loop: the View posts the materialized
 * transaction via the existing builders and advances `nextRunAt`. v1 covers
 * recurring EXPENSES (bills); `kind` leaves room for sale/journal later.
 *
 * DGII: a generated expense carries a BLANK NCF — the dealer adds the real
 * supplier NCF (it changes each period) before it feeds the 606.
 */
import type { RecurringTemplate } from '../../types/domain.ts';
import { round2 } from './ledger.js';

const DAY = 86400000;

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** One cadence step forward from `ts`, keeping the anchor day/weekday. */
function step(ts: number, freq: string, interval: number): number {
  const d = new Date(ts);
  if (freq === 'weekly') return ts + interval * 7 * DAY;
  if (freq === 'yearly') {
    const y = d.getUTCFullYear() + interval;
    return Date.UTC(y, d.getUTCMonth(), Math.min(d.getUTCDate(), daysInMonth(y, d.getUTCMonth())), d.getUTCHours(), d.getUTCMinutes());
  }
  // monthly
  let m = d.getUTCMonth() + interval;
  const y = d.getUTCFullYear() + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return Date.UTC(y, m, Math.min(d.getUTCDate(), daysInMonth(y, m)), d.getUTCHours(), d.getUTCMinutes());
}

/** First occurrence strictly after `after`, stepping from `startAt`. */
export function nextOccurrence(t: Pick<RecurringTemplate, 'freq' | 'interval' | 'startAt'>, after: number): number {
  const interval = Math.max(1, Math.trunc(t.interval || 1));
  let occ = t.startAt;
  let guard = 0;
  while (occ <= after && guard++ < 5000) occ = step(occ, t.freq, interval);
  return occ;
}

/** Is the template due to run as of `now`? */
export function isDue(t: RecurringTemplate, now: number): boolean {
  return t.status === 'active'
    && typeof t.nextRunAt === 'number'
    && t.nextRunAt <= now
    && (!t.endAt || t.nextRunAt <= t.endAt);
}

/** Advance a template past its current run: stamp lastRunAt, compute nextRunAt. */
export function advance(t: RecurringTemplate): RecurringTemplate {
  return { ...t, lastRunAt: t.nextRunAt, nextRunAt: nextOccurrence(t, t.nextRunAt) };
}

/** Materialize a recurring EXPENSE — an Expense-shaped object (blank NCF; the
 *  dealer adds the real one). The View posts it via buildExpenseEntry. */
export function materializeExpense(t: RecurringTemplate, runAt?: number) {
  const p = t.payload || {};
  return {
    supplierId: p.supplierId || null,
    accountCode: p.accountCode || null,
    description: p.description || t.name,
    expenseAt: runAt ?? t.nextRunAt,
    ncf: '',
    base: round2(p.base || 0),
    itbis: round2(p.itbis || 0),
    itbisCreditable: p.itbisCreditable !== false,
    retentionIsr: round2(p.retentionIsr || 0),
    retentionItbis: round2(p.retentionItbis || 0),
    paymentMethod: p.paymentMethod || 'credit',
  };
}
