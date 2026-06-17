/**
 * Tests for the DGII filing-deadline metadata (the periodic-report `dueDay` on
 * the fiscal plugin) and the resolveFilingDeadline VM that turns it into a live
 * "next deadline + days left + period filed". Pins the official due dates:
 * 606/607 by the 15th, IT-1 by the 20th of the FOLLOWING month.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dgiiPlugin, resolveFilingDeadline } from '../src/core/accounting/index.js';

test('DGII report deadlines: 606/607 by the 15th, IT-1 by the 20th', () => {
  const byCode = Object.fromEntries(dgiiPlugin.reports.map((r) => [r.code, r]));
  assert.equal(byCode['606'].dueDay, 15);
  assert.equal(byCode['607'].dueDay, 15);
  assert.equal(byCode['IT-1'].dueDay, 20);
  // e-CF is per-document, not a periodic filing → no dueDay.
  assert.equal(byCode['e-CF'].dueDay, undefined);
});

test('resolveFilingDeadline: before the due day, files the prior month', () => {
  const now = Date.parse('2026-06-17T12:00:00'); // local
  const d = resolveFilingDeadline(20, now); // IT-1
  // June 17 < June 20 → IT-1 for May (202605) is due June 20.
  assert.equal(d.period, '202605');
  assert.equal(new Date(d.dueAt).getMonth(), 5); // June (0-based)
  assert.equal(new Date(d.dueAt).getDate(), 20);
  assert.equal(d.daysLeft, 3);
});

test('resolveFilingDeadline: after the due day, rolls to next month', () => {
  const now = Date.parse('2026-06-17T12:00:00');
  const d = resolveFilingDeadline(15, now); // 606/607 — June 15 already passed
  assert.equal(d.period, '202606'); // now filing June, due in July
  assert.equal(new Date(d.dueAt).getMonth(), 6); // July
  assert.equal(new Date(d.dueAt).getDate(), 15);
});

test('resolveFilingDeadline: due today is 0 days left, still the prior period', () => {
  const now = Date.parse('2026-06-15T09:00:00');
  const d = resolveFilingDeadline(15, now);
  assert.equal(d.daysLeft, 0);
  assert.equal(d.period, '202605');
});

test('resolveFilingDeadline: year-end rolls the period across December', () => {
  const now = Date.parse('2026-12-31T12:00:00'); // Dec 15 passed
  const d = resolveFilingDeadline(15, now);
  assert.equal(d.period, '202612'); // filing December
  assert.equal(new Date(d.dueAt).getFullYear(), 2027);
  assert.equal(new Date(d.dueAt).getMonth(), 0); // January
});

test('resolveFilingDeadline: invalid dueDay → null (non-periodic filing)', () => {
  assert.equal(resolveFilingDeadline(0), null);
  assert.equal(resolveFilingDeadline(undefined), null);
  assert.equal(resolveFilingDeadline(null), null);
});
