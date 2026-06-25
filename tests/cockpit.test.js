/**
 * Tests for the accounting cockpit VM (src/core/accounting/cockpit.js): the
 * fiscal-deadline tracker, period-close status, and the prioritized action
 * center (e-CF backlog, filing due soon, overdue cuentas, quotes to invoice,
 * close last month). Deterministic `now` is passed in (no Date.now()).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingCockpit } from '../src/core/accounting/cockpit.js';

const DAY = 86_400_000;
// 2026-06-10 — before the 15th (606/607) and 20th (IT-1) deadlines of June.
const NOW = new Date(2026, 5, 10, 12, 0, 0).getTime();

test('deadlines: 606/607 due the 15th, IT-1 the 20th, sorted by days left', () => {
  const c = resolveAccountingCockpit({ now: NOW });
  const codes = c.deadlines.map((d) => d.code);
  assert.deepEqual(codes, ['606', '607', 'IT-1']); // 606/607 (day 15) before IT-1 (day 20)
  const d606 = c.deadlines.find((d) => d.code === '606');
  assert.equal(d606.daysLeft, 5);                  // 10th → 15th
  assert.equal(d606.periodLabel, 'Mayo 2026');     // June filing covers May
  assert.equal(c.deadlines.find((d) => d.code === 'IT-1').daysLeft, 10);
  // The e-CF report (no dueDay) is not a periodic deadline.
  assert.ok(!codes.includes('e-CF'));
});

test('deadline severity: ≤2 danger, ≤7 warn, else info', () => {
  const near = resolveAccountingCockpit({ now: new Date(2026, 5, 14, 12).getTime() }); // 1 day to the 15th
  assert.equal(near.deadlines.find((d) => d.code === '606').severity, 'danger');
  const mid = resolveAccountingCockpit({ now: NOW }); // 5 days
  assert.equal(mid.deadlines.find((d) => d.code === '606').severity, 'warn');
  const far = resolveAccountingCockpit({ now: new Date(2026, 5, 1, 12).getTime() }); // 14 days
  assert.equal(far.deadlines.find((d) => d.code === '606').severity, 'info');
});

test('period close: flags the previous month open + reports the last closed', () => {
  const open = resolveAccountingCockpit({ now: NOW, fiscalPeriods: [] });
  assert.equal(open.periodClose.prevLabel, 'Mayo 2026');
  assert.equal(open.periodClose.prevClosed, false);
  assert.equal(open.periodClose.currentLabel, 'Junio 2026');
  assert.ok(open.actions.some((a) => a.kind === 'periodClose'));

  const closed = resolveAccountingCockpit({
    now: NOW,
    fiscalPeriods: [{ year: 2026, month: 5, status: 'closed' }, { year: 2026, month: 4, status: 'closed' }],
  });
  assert.equal(closed.periodClose.prevClosed, true);
  assert.equal(closed.periodClose.lastClosedLabel, 'Mayo 2026');
  assert.ok(!closed.actions.some((a) => a.kind === 'periodClose'));
});

test('action center: e-CF backlog, overdue AP/AR, quotes to invoice — prioritized', () => {
  const c = resolveAccountingCockpit({
    now: NOW,
    fiscalPeriods: [{ year: 2026, month: 5, status: 'closed' }], // prev closed → no periodClose action
    salesPostings: [
      { id: 'sp1', quoteId: 'q1', ncf: 'E310000001', ecfStatus: 'draft' }, // pending e-CF + invoices q1
    ],
    quotes: [
      { id: 'q1', status: 'accepted', depositReceivedAt: NOW - DAY }, // ready, but invoiced (sp1) → not counted
      { id: 'q2', status: 'accepted', depositReceivedAt: NOW - DAY }, // floor sale, deposit in, not invoiced → to-invoice
      { id: 'q3', status: 'sent' },     // not accepted → ignored
      { id: 'q4', status: 'accepted' }, // accepted but NOT ready (no delivery / no deposit) → not counted
    ],
    // a credit purchase 120 days old → overdue payable (+90 → danger)
    purchases: [{ id: 'p1', supplierId: 's1', purchaseAt: NOW - 120 * DAY, paymentMethod: 'credit', base: 10000, itbis: 1800 }],
    payments: [],
  });
  const byKind = Object.fromEntries(c.actions.map((a) => [a.kind, a]));
  assert.equal(byKind.ecf.count, 1);
  assert.equal(byKind.invoice.count, 1);          // only q2
  assert.ok(byKind.payable.amount > 0);
  assert.equal(byKind.payable.severity, 'danger'); // 120 days → +90 bucket
  // danger sorts before warn before info
  const ranks = c.actions.map((a) => ({ danger: 0, warn: 1, info: 2 }[a.severity]));
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
  assert.equal(c.counts.danger, c.actions.filter((a) => a.severity === 'danger').length);
});

test('quiet books: only the (info) close-last-month nudge, nothing urgent', () => {
  const c = resolveAccountingCockpit({ now: new Date(2026, 5, 1, 12).getTime(), fiscalPeriods: [] });
  assert.equal(c.counts.danger, 0);
  assert.deepEqual([...new Set(c.actions.map((a) => a.kind))], ['periodClose']);
});
