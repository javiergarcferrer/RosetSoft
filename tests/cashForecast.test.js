/** 13-week cash forecast — weekly inflow/outflow bucketing, running balance,
 *  recurring outflows, and the runway low point. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCashForecast } from '../src/core/accounting/cashForecast.js';

const DAY = 86400000;
const WEEK = 7 * DAY;
const NOW = Date.UTC(2026, 5, 1);

const receivables = { rows: [{ docs: [
  { docId: 'i1', date: NOW + 3 * DAY, open: 40000 },   // week 0
  { docId: 'i2', date: NOW + 10 * DAY, open: 20000 },  // week 1
  { docId: 'i3', date: NOW - 5 * DAY, open: 5000 },    // overdue → week 0
] }] };
const payables = { rows: [{ docs: [
  { docId: 'b1', date: NOW + 2 * DAY, open: 30000 },   // week 0
] }] };
const recurring = [
  { status: 'active', freq: 'weekly', interval: 1, startAt: NOW, nextRunAt: NOW, payload: { base: 1000, itbis: 0 } }, // every week
  { status: 'paused', freq: 'weekly', interval: 1, startAt: NOW, nextRunAt: NOW, payload: { base: 9999, itbis: 0 } }, // ignored
];

test('buckets flows into weeks with a running balance', () => {
  const f = resolveCashForecast({ receivables, payables, recurring, openingCash: 10000, now: NOW, weeks: 4 });
  assert.equal(f.rows.length, 4);
  // week 0: in 40000+5000=45000, out 30000 + recurring 1000 = 31000 → net 14000 → bal 24000
  assert.equal(f.rows[0].inflow, 45000);
  assert.equal(f.rows[0].outflow, 31000);
  assert.equal(f.rows[0].balance, 24000);
  // week 1: in 20000, out recurring 1000 → net 19000 → bal 43000
  assert.equal(f.rows[1].inflow, 20000);
  assert.equal(f.rows[1].balance, 43000);
  assert.equal(f.totalIn, 65000);
});

test('flags the runway low point and any negative week', () => {
  // tiny opening, a big bill in week 0 → goes negative
  const f = resolveCashForecast({
    receivables: { rows: [] },
    payables: { rows: [{ docs: [{ docId: 'b', date: NOW + DAY, open: 5000 }] }] },
    recurring: [], openingCash: 1000, now: NOW, weeks: 3,
  });
  assert.equal(f.rows[0].balance, -4000);
  assert.ok(f.negativeWeek);
  assert.equal(f.negativeWeek.week, 0);
  assert.equal(f.lowPoint.balance, -4000);
});

test('paused recurring templates are excluded', () => {
  const f = resolveCashForecast({ receivables: { rows: [] }, payables: { rows: [] }, recurring, openingCash: 0, now: NOW, weeks: 2 });
  assert.equal(f.rows[0].outflow, 1000); // only the active weekly template
});
