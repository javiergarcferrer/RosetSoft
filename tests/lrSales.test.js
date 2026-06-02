/**
 * Tests for the Ligne Roset sales report ViewModel (src/core/accounting/lrSales.js).
 *
 * What we report to the supplier each month is our FLOOR sales: accepted quotes
 * NOT tied to an import order, recognized when the deposit lands. The report is
 * one row per priced product sold, summed in USD. These tests pin the inclusion
 * rule (status + no order + deposit-in-window), the per-row money, and the
 * previous-month default that drives the "send on the 15th" flow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLrSales, lrSalesCsv, monthRange, previousMonth, monthLabel,
} from '../src/core/accounting/lrSales.js';
import { quoteFloorSaleRows } from '../src/core/bridge/index.js';

const may = monthRange(2026, 4); // mayo 2026 → { start, end }
const midMay = Date.parse('2026-05-15T12:00:00-04:00');
const midApril = Date.parse('2026-04-15T12:00:00-04:00');

const customers = new Map([['c1', { id: 'c1', name: 'Cliente Uno' }]]);

function run(quotes, linesByQuote) {
  // Price each quote's lines through the bridge (the View's job), then hand the
  // accounting VM the per-product rows it now consumes.
  const floorRowsByQuote = new Map();
  for (const [quoteId, lines] of Object.entries(linesByQuote || {})) {
    floorRowsByQuote.set(quoteId, quoteFloorSaleRows({ lines }));
  }
  return resolveLrSales({
    quotes,
    floorRowsByQuote,
    customersById: customers,
    start: may.start,
    end: may.end,
  });
}

test('includes an accepted floor sale with its deposit in the window', () => {
  const r = run(
    [{ id: 'q1', number: 10, status: 'accepted', customerId: 'c1', depositReceivedAt: midMay }],
    { q1: [{ id: 'l1', quoteId: 'q1', kind: 'item', reference: 'TOGO', name: 'Togo', qty: 2, unitPrice: 1000 }] },
  );
  assert.equal(r.lineCount, 1);
  assert.equal(r.salesCount, 1);
  assert.equal(r.rows[0].reference, 'TOGO');
  assert.equal(r.rows[0].qty, 2);
  assert.equal(r.rows[0].unitUsd, 1000);
  assert.equal(r.rows[0].totalUsd, 2000);
  assert.equal(r.totals.qty, 2);
  assert.equal(r.totals.usd, 2000);
});

test('excludes a quote tied to an import order (special, not floor)', () => {
  const r = run(
    [{ id: 'q1', status: 'accepted', orderId: 'o1', customerId: 'c1', depositReceivedAt: midMay }],
    { q1: [{ id: 'l1', quoteId: 'q1', kind: 'item', qty: 1, unitPrice: 500 }] },
  );
  assert.equal(r.lineCount, 0);
});

test('excludes a deposit that landed in another month', () => {
  const r = run(
    [{ id: 'q1', status: 'accepted', customerId: 'c1', depositReceivedAt: midApril }],
    { q1: [{ id: 'l1', quoteId: 'q1', kind: 'item', qty: 1, unitPrice: 500 }] },
  );
  assert.equal(r.lineCount, 0);
});

test('excludes a floor quote that has no deposit yet', () => {
  const r = run(
    [{ id: 'q1', status: 'accepted', customerId: 'c1', depositReceivedAt: null }],
    { q1: [{ id: 'l1', quoteId: 'q1', kind: 'item', qty: 1, unitPrice: 500 }] },
  );
  assert.equal(r.lineCount, 0);
});

test('excludes a non-accepted quote', () => {
  const r = run(
    [{ id: 'q1', status: 'sent', customerId: 'c1', depositReceivedAt: midMay }],
    { q1: [{ id: 'l1', quoteId: 'q1', kind: 'item', qty: 1, unitPrice: 500 }] },
  );
  assert.equal(r.lineCount, 0);
});

test('skips sections and unselected alternatives, keeps the selected one', () => {
  const r = run(
    [{ id: 'q1', status: 'accepted', customerId: 'c1', depositReceivedAt: midMay }],
    { q1: [
      { id: 's1', quoteId: 'q1', kind: 'section', name: 'Sala' },
      { id: 'a1', quoteId: 'q1', kind: 'item', alternativeGroup: 'g', isSelectedAlternative: true, qty: 1, unitPrice: 700 },
      { id: 'a2', quoteId: 'q1', kind: 'item', alternativeGroup: 'g', isSelectedAlternative: false, qty: 1, unitPrice: 900 },
    ] },
  );
  assert.equal(r.lineCount, 1);
  assert.equal(r.rows[0].totalUsd, 700);
});

test('a compound rolls up to one row at its priced-component total', () => {
  const r = run(
    [{ id: 'q1', status: 'accepted', customerId: 'c1', depositReceivedAt: midMay }],
    { q1: [{
      id: 'l1', quoteId: 'q1', kind: 'item', reference: 'PLUMY', name: 'Plumy',
      components: [
        { id: 'c1', qty: 1, unitPrice: 1200 },
        { id: 'c2', qty: 2, unitPrice: 300 },
        { id: 'c3', qty: 1, unitPrice: 999, isOptional: true }, // excluded
      ],
    }] },
  );
  assert.equal(r.lineCount, 1);
  assert.equal(r.rows[0].qty, 1);
  assert.equal(r.rows[0].totalUsd, 1800); // 1200 + 2*300, optional skipped
});

test('CSV carries a header, a row per product, and a totals footer', () => {
  const report = run(
    [{ id: 'q1', number: 10, status: 'accepted', customerId: 'c1', depositReceivedAt: midMay }],
    { q1: [{ id: 'l1', quoteId: 'q1', kind: 'item', reference: 'TOGO', name: 'Togo', qty: 2, unitPrice: 1000 }] },
  );
  const rows = lrSalesCsv(report);
  assert.equal(rows.length, 3); // header + 1 product + footer
  assert.equal(rows[0][0], 'Fecha');
  assert.equal(rows[1][3], 'TOGO');
  assert.equal(rows[2][8], 2000); // total USD in the footer
});

test('previousMonth wraps a January into the prior December', () => {
  const jan = previousMonth(Date.parse('2026-01-10T12:00:00-04:00'));
  assert.deepEqual(jan, { year: 2025, monthIndex: 11 });
  assert.equal(monthLabel(jan.year, jan.monthIndex), 'diciembre 2025');
});
