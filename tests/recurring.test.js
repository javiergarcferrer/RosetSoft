/**
 * Recurring transactions — cadence stepping (anchor day, month-end clamp),
 * due-gating, advance, expense materialization, and the agenda VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, isDue, advance, materializeExpense } from '../src/lib/accounting/recurring.js';
import { resolveRecurring } from '../src/core/accounting/recurring.js';

const DAY = 86400000;

test('nextOccurrence steps monthly keeping the anchor day', () => {
  const t = { freq: 'monthly', interval: 1, startAt: Date.UTC(2026, 0, 15) };
  assert.equal(nextOccurrence(t, Date.UTC(2026, 2, 1)), Date.UTC(2026, 2, 15)); // → Mar 15
  assert.equal(nextOccurrence(t, Date.UTC(2026, 0, 15)), Date.UTC(2026, 1, 15)); // strictly after
});

test('monthly clamps the anchor day on short months', () => {
  const t = { freq: 'monthly', interval: 1, startAt: Date.UTC(2026, 0, 31) };
  assert.equal(nextOccurrence(t, Date.UTC(2026, 0, 31)), Date.UTC(2026, 1, 28)); // Jan 31 → Feb 28
});

test('weekly + yearly stepping', () => {
  assert.equal(nextOccurrence({ freq: 'weekly', interval: 2, startAt: Date.UTC(2026, 0, 1) }, Date.UTC(2026, 0, 1)), Date.UTC(2026, 0, 15));
  assert.equal(nextOccurrence({ freq: 'yearly', interval: 1, startAt: Date.UTC(2026, 5, 10) }, Date.UTC(2026, 5, 10)), Date.UTC(2027, 5, 10));
});

test('isDue gates on status, nextRunAt and endAt', () => {
  const base = { status: 'active', freq: 'monthly', interval: 1, startAt: 0, nextRunAt: 1000 };
  assert.equal(isDue(base, 2000), true);
  assert.equal(isDue(base, 500), false);             // not yet
  assert.equal(isDue({ ...base, status: 'paused' }, 2000), false);
  assert.equal(isDue({ ...base, endAt: 900 }, 2000), false); // past its end
});

test('advance stamps lastRunAt and moves nextRunAt forward', () => {
  const t = { status: 'active', freq: 'monthly', interval: 1, startAt: Date.UTC(2026, 0, 10), nextRunAt: Date.UTC(2026, 0, 10) };
  const a = advance(t);
  assert.equal(a.lastRunAt, Date.UTC(2026, 0, 10));
  assert.equal(a.nextRunAt, Date.UTC(2026, 1, 10));
});

test('materializeExpense builds an Expense skeleton with a blank NCF', () => {
  const t = {
    name: 'Alquiler', nextRunAt: Date.UTC(2026, 2, 1),
    payload: { supplierId: 's1', accountCode: '6-03-002-00-00-00', description: 'Alquiler local', base: 50000, itbis: 9000, paymentMethod: 'credit' },
  };
  const e = materializeExpense(t);
  assert.equal(e.accountCode, '6-03-002-00-00-00');
  assert.equal(e.base, 50000);
  assert.equal(e.itbis, 9000);
  assert.equal(e.ncf, '');             // dealer adds the real NCF for the 606
  assert.equal(e.paymentMethod, 'credit');
  assert.equal(e.expenseAt, Date.UTC(2026, 2, 1));
});

test('resolveRecurring buckets due / upcoming / paused', () => {
  const NOW = Date.UTC(2026, 5, 1);
  const templates = [
    { id: 'r1', name: 'Internet', kind: 'expense', status: 'active', freq: 'monthly', interval: 1, startAt: NOW - 40 * DAY, nextRunAt: NOW - 5 * DAY, payload: { base: 2000, itbis: 360 } },
    { id: 'r2', name: 'Hosting', kind: 'expense', status: 'active', freq: 'monthly', interval: 1, startAt: NOW, nextRunAt: NOW + 20 * DAY, payload: { base: 1000, itbis: 180 } },
    { id: 'r3', name: 'Viejo', kind: 'expense', status: 'paused', freq: 'monthly', interval: 1, startAt: 0, nextRunAt: NOW - 100 * DAY, payload: { base: 500, itbis: 0 } },
  ];
  const r = resolveRecurring({ templates, now: NOW });
  assert.equal(r.dueCount, 1);
  assert.equal(r.due[0].name, 'Internet');
  assert.equal(r.dueTotal, 2360);
  assert.equal(r.upcoming.length, 1);
  assert.equal(r.upcoming[0].name, 'Hosting');
  assert.equal(r.paused.length, 1);
  assert.equal(r.due[0].scheduleLabel, 'Cada mes');
});
