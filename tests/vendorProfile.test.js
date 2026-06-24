/** Vendor 360 — open balance (credit docs − pagos), YTD spend + retentions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVendorProfile } from '../src/core/accounting/vendorProfile.js';

const supplier = { id: 's1', name: 'Claro', rnc: '101010101' };
const Y = 2026;
const purchases = [{ id: 'p1', supplierId: 's1', purchaseAt: Date.UTC(Y, 1, 1), ncf: 'B01', base: 10000, itbis: 1800, paymentMethod: 'credit', retentionIsr: 0, retentionItbis: 0 }];
const expenses = [
  { id: 'e1', supplierId: 's1', expenseAt: Date.UTC(Y, 2, 1), ncf: 'B02', base: 1000, itbis: 180, paymentMethod: 'credit', retentionIsr: 100, retentionItbis: 54 },
  { id: 'e2', supplierId: 's1', expenseAt: Date.UTC(Y - 1, 5, 1), ncf: 'B00', base: 500, itbis: 90, paymentMethod: 'cash', retentionIsr: 0, retentionItbis: 0 }, // prior year
  { id: 'e3', supplierId: 's2', expenseAt: Date.UTC(Y, 2, 1), ncf: 'B03', base: 999, itbis: 0, paymentMethod: 'credit' }, // other supplier
];
const payments = [{ id: 'pay1', direction: 'out', partyId: 's1', amount: 5000 }];

test('open balance = credit charges (net of retentions) − pagos', () => {
  const v = resolveVendorProfile({ supplier, purchases, expenses, payments, year: Y });
  // credit docs: p1 11800 + e1 (1180 − 100 − 54 = 1026) = 12826; paid 5000 → 7826
  assert.equal(v.balance, 7826);
});

test('YTD totals exclude prior year + other suppliers', () => {
  const v = resolveVendorProfile({ supplier, purchases, expenses, payments, year: Y });
  assert.equal(v.ytd.spend, 11000);   // 10000 + 1000 (not the 500 prior-year, not s2)
  assert.equal(v.ytd.itbis, 1980);
  assert.equal(v.ytd.retIsr, 100);
  assert.equal(v.ytd.retItbis, 54);
  assert.equal(v.ytd.count, 2);
  assert.equal(v.docCount, 3);        // all-time docs for s1 (incl. prior year)
  assert.equal(v.recentDocs[0].kind, 'Gasto'); // newest (Mar) first
});
