/**
 * Tests for the Inventario + Compras module — weighted-average kardex
 * (src/lib/accounting/inventory.ts), the purchase + COGS asientos
 * (src/lib/accounting/purchase.ts), inventory valuation
 * (src/core/accounting/inventory.js), and the 606 now folding in purchases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { weightedAverageIn, resolveKardex } from '../src/lib/accounting/inventory.js';
import { buildPurchaseEntry, buildCogsEntry } from '../src/lib/accounting/purchase.js';
import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';
import { resolveInventory, resolveItemKardex } from '../src/core/accounting/inventory.js';
import { resolve606 } from '../src/core/accounting/expenses.js';

const config = resolveAccountingConfig(null);
const M = config.postingMap;
function ids() { let n = 0; return () => `id${++n}`; }

/* --------------------------- weighted average --------------------------- */

test('weightedAverageIn blends costs by quantity', () => {
  // 10 @ 100 then 10 @ 200 → avg 150
  assert.equal(weightedAverageIn(10, 100, 10, 200), 150);
  // first receipt sets the average
  assert.equal(weightedAverageIn(0, 0, 5, 80), 80);
});

test('resolveKardex replays movements into running qty/avg/value', () => {
  const movements = [
    { id: 'm1', itemId: 'i1', type: 'in', qty: 10, unitCost: 100, movedAt: 1 },
    { id: 'm2', itemId: 'i1', type: 'in', qty: 10, unitCost: 200, movedAt: 2 },
    { id: 'm3', itemId: 'i1', type: 'out', qty: 5, unitCost: 0, movedAt: 3 },
  ];
  const k = resolveKardex(movements);
  assert.equal(k.qty, 15);
  assert.equal(k.avgCost, 150);            // (10·100 + 10·200)/20
  assert.equal(k.value, 2250);             // 15 × 150
  assert.equal(k.rows[2].costOut, 750);    // 5 × 150 cost of sale
});

test('resolveInventory values each item from its movements', () => {
  const items = [{ id: 'i1', name: 'Sofá', sku: 'S1' }, { id: 'i2', name: 'Mesa', sku: 'M1' }];
  const movements = [
    { id: 'm1', itemId: 'i1', type: 'in', qty: 2, unitCost: 1000, movedAt: 1 },
    { id: 'm2', itemId: 'i2', type: 'in', qty: 4, unitCost: 250, movedAt: 1 },
  ];
  const r = resolveInventory({ items, movements });
  assert.equal(r.count, 2);
  assert.equal(r.totalValue, 3000); // 2·1000 + 4·250
  const sofa = r.rows.find((x) => x.item.id === 'i1');
  assert.equal(sofa.qty, 2);
  assert.equal(sofa.avgCost, 1000);
});

/* ------------------------------- purchase ------------------------------- */

test('buildPurchaseEntry (goods) debits inventory and balances', () => {
  const { entry, lines } = buildPurchaseEntry({
    newId: ids(), config,
    purchase: {
      id: 'p1', kind: 'goods', supplierId: 's1', base: 50000, itbis: 9000,
      retentionIsr: 0, retentionItbis: 0, paymentMethod: 'credit', ncf: 'B0100000010',
    },
  });
  assert.equal(entry.source, 'purchase');
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.inventory).debit, 50000);
  assert.equal(lines.find((l) => l.accountCode === M.itbisCredit).debit, 9000);
  assert.equal(lines.find((l) => l.accountCode === M.accountsPayable).credit, 59000);
});

test('buildPurchaseEntry (asset) debits the given account', () => {
  const { lines } = buildPurchaseEntry({
    newId: ids(), config,
    purchase: {
      id: 'p2', kind: 'asset', accountCode: '1-02-003-00-00-00', base: 30000, itbis: 5400,
      retentionIsr: 0, retentionItbis: 0, paymentMethod: 'bank',
    },
  });
  assert.equal(lines.find((l) => l.accountCode === '1-02-003-00-00-00').debit, 30000);
  assert.equal(debitTotal(lines), creditTotal(lines));
});

test('buildCogsEntry posts costo de venta / inventario', () => {
  const { lines } = buildCogsEntry({ newId: ids(), config, cost: 1500 });
  assert.equal(lines.find((l) => l.accountCode === M.costOfSales).debit, 1500);
  assert.equal(lines.find((l) => l.accountCode === M.inventory).credit, 1500);
  assert.equal(debitTotal(lines), creditTotal(lines));
});

test('buildCogsEntry refuses a non-positive cost', () => {
  assert.throws(() => buildCogsEntry({ newId: ids(), config, cost: 0 }), /mayor que cero/);
});

/* --------------------------------- 606 ---------------------------------- */

test('resolve606 folds purchases in with expenses', () => {
  const suppliers = [{ id: 's1', name: 'LR', rnc: '101', kind: 'juridica' }];
  const expenses = [{ id: 'e1', supplierId: 's1', expenseAt: 1000, ncf: 'E1', base: 1000, itbis: 180, retentionIsr: 0, retentionItbis: 0 }];
  const purchases = [{ id: 'p1', supplierId: 's1', purchaseAt: 2000, ncf: 'P1', base: 50000, itbis: 9000, retentionIsr: 0, retentionItbis: 0 }];
  const r = resolve606({ expenses, purchases, suppliers });
  assert.equal(r.count, 2);
  assert.equal(r.totals.base, 51000);
  assert.equal(r.totals.itbis, 9180);
});
