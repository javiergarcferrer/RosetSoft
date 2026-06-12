/**
 * Tests for the commission payout-cycle math (src/lib/commissionCycle.ts) —
 * the 16th→15th window every commission surface (Comisiones, the accounting
 * workspace, the CSV exports) keys on. Money-adjacent: a wrong window moves a
 * sale into the wrong payout. Pins the day-15/16 rollover, the year wrap, the
 * contiguity of consecutive cycles, and the ISO date helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cycleEnding, isoDate, parseISODate, clampPct } from '../src/lib/commissionCycle.js';

const d = (y, m, day, ...rest) => new Date(y, m - 1, day, ...rest);

test('before/on the 15th the active cycle ends this month; from the 16th it rolls forward', () => {
  // Jun 10 → 16 May .. 15 Jun.
  let c = cycleEnding(d(2026, 6, 10), 0);
  assert.equal(isoDate(c.start), '2026-05-16');
  assert.equal(isoDate(c.end), '2026-06-15');
  // Jun 15 (payout day) still belongs to the cycle ending today.
  c = cycleEnding(d(2026, 6, 15), 0);
  assert.equal(isoDate(c.end), '2026-06-15');
  // Jun 16 → the active window is already 16 Jun .. 15 Jul.
  c = cycleEnding(d(2026, 6, 16), 0);
  assert.equal(isoDate(c.start), '2026-06-16');
  assert.equal(isoDate(c.end), '2026-07-15');
});

test('year wrap: early January reaches back into December; late December reaches into January', () => {
  let c = cycleEnding(d(2026, 1, 10), 0);
  assert.equal(isoDate(c.start), '2025-12-16');
  assert.equal(isoDate(c.end), '2026-01-15');
  c = cycleEnding(d(2025, 12, 20), 0);
  assert.equal(isoDate(c.start), '2025-12-16');
  assert.equal(isoDate(c.end), '2026-01-15');
});

test('consecutive cycles tile the calendar with no gap and no overlap', () => {
  const now = d(2026, 6, 12);
  const prev = cycleEnding(now, -1);
  const curr = cycleEnding(now, 0);
  assert.equal(prev.end + 1, curr.start); // 15th 23:59:59.999 + 1ms = 16th 00:00
  assert.equal(isoDate(prev.start), '2026-04-16');
  assert.equal(isoDate(prev.end), '2026-05-15');
});

test('parseISODate: start vs end of day; clampPct bounds', () => {
  const start = parseISODate('2026-06-12');
  const end = parseISODate('2026-06-12', true);
  assert.equal(end - start, 86_400_000 - 1);
  assert.equal(isoDate(start), '2026-06-12');
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(150), 100);
  assert.equal(clampPct('12.5'), 12.5);
  assert.equal(clampPct('nope'), 0);
});
