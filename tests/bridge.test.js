/**
 * Tests for the CRM↔Accounting bridge (src/core/bridge) — the one place the two
 * cores meet. `quoteToSale` must turn a USD CRM quote into the DOP accounting
 * figures at the given rate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { quoteToSale, resolveQuoteInvoiceStatus } from '../src/core/bridge/index.js';
import { computeTotals, lineForTotals } from '../src/lib/pricing.js';
import { isPricedLine } from '../src/lib/constants.js';

const quote = { id: 'q1', number: 5, customerId: 'c1', depositAmount: 50, marginPct: 0, discountPct: 0, shipping: 0 };
const lines = [{ id: 'l1', quoteId: 'q1', kind: 'item', qty: 1, unitPrice: 100 }];
const r2 = (n) => Math.round(n * 100) / 100;

test('quoteToSale converts a USD quote into DOP accounting figures at the rate', () => {
  const t = computeTotals(lines.filter(isPricedLine).map(lineForTotals), quote);
  const sale = quoteToSale({ quote, lines, rate: 60, hasFiscalId: true });
  assert.equal(sale.base, r2(t.taxableBase * 60));
  assert.equal(sale.itbis, r2(t.taxAmt * 60));
  assert.equal(sale.total, r2(t.grandTotal * 60));
  assert.equal(sale.deposit, 3000); // 50 × 60
  assert.equal(sale.customerId, 'c1');
  assert.equal(sale.quoteId, 'q1');
});

test('quoteToSale picks the e-CF type from the buyer fiscal id', () => {
  assert.equal(quoteToSale({ quote, lines, rate: 60, hasFiscalId: true }).ecfType, '31');
  assert.equal(quoteToSale({ quote, lines, rate: 60, hasFiscalId: false }).ecfType, '32');
});

test('quoteToSale: total reconciles to base + ITBIS when no shipping', () => {
  const sale = quoteToSale({ quote, lines, rate: 60, hasFiscalId: false });
  assert.equal(sale.total, r2(sale.base + sale.itbis));
});

test('resolveQuoteInvoiceStatus: one stamp per quote, latest posting wins, no quoteId → skipped', () => {
  const m = resolveQuoteInvoiceStatus([
    { quoteId: 'q1', ncf: 'B0200000001', ecfStatus: '', postedAt: 100 },
    // A re-posting (e.g. corrected NCF) replaces the older stamp.
    { quoteId: 'q1', ncf: 'E310000000007', ecfStatus: 'sent', postedAt: 200 },
    { quoteId: null, ncf: 'B0200000009', postedAt: 300 }, // manual posting w/o quote
    { quoteId: 'q2', ncf: '', postedAt: 50 },
  ]);
  assert.equal(m.size, 2);
  assert.deepEqual(m.get('q1'), { ncf: 'E310000000007', ecfStatus: 'sent', postedAt: 200 });
  assert.deepEqual(m.get('q2'), { ncf: '', ecfStatus: '', postedAt: 50 });
  assert.equal(resolveQuoteInvoiceStatus(null).size, 0);
});
