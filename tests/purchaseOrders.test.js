/** Purchase orders — line totals, status filter, open-commitment total. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { poTotals, resolvePurchaseOrders, PO_STATUS_LABEL } from '../src/core/accounting/purchaseOrders.js';

test('poTotals sums qty and amount', () => {
  const t = poTotals({ lines: [{ qty: 2, unitCost: 1500 }, { qty: 3, unitCost: 1000 }] });
  assert.equal(t.qty, 5);
  assert.equal(t.total, 6000);
});

const suppliersById = new Map([['s1', { id: 's1', name: 'Roset' }]]);
const orders = [
  { id: 'po1', number: 1, supplierId: 's1', orderedAt: 200, status: 'open', lines: [{ qty: 2, unitCost: 1500 }] },
  { id: 'po2', number: 2, supplierId: 's1', orderedAt: 300, status: 'received', lines: [{ qty: 1, unitCost: 5000 }] },
  { id: 'po3', number: 3, supplierId: 's1', orderedAt: 100, status: 'billed', lines: [{ qty: 1, unitCost: 9000 }] },
];

test('resolvePurchaseOrders lists newest-first with totals + status counts', () => {
  const r = resolvePurchaseOrders({ orders, suppliersById });
  assert.equal(r.count, 3);
  assert.equal(r.rows[0].po.id, 'po2');         // newest orderedAt
  assert.equal(r.rows[0].total, 5000);
  assert.equal(r.rows[0].statusLabel, PO_STATUS_LABEL.received);
  assert.equal(r.byStatus.open, 1);
  assert.equal(r.openTotal, 8000);              // open(3000) + received(5000), not billed
});

test('status + query filters', () => {
  assert.equal(resolvePurchaseOrders({ orders, suppliersById, statusFilter: 'billed' }).count, 1);
  assert.equal(resolvePurchaseOrders({ orders, suppliersById, query: 'roset' }).count, 3);
});
