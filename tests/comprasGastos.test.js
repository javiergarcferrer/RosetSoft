/**
 * Tests for the unified Compras y gastos list (src/core/accounting/compras.js):
 * the merge of expenses + purchases into one row shape discriminated by nature,
 * the nature/supplier/date/query filters, per-nature chip counts and totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePurchasesExpenses, purchaseNature } from '../src/core/accounting/compras.js';

const SUPPLIERS = [
  { id: 's1', name: 'Claro', rnc: '101010101' },
  { id: 's2', name: 'Mueblería RD', rnc: '00112345678' },
];
const ACCOUNTS = [{ code: '6-02-007-01-03-00', name: 'TELEFONO E INTERNET' }];
const EXPEDIENTES = [{ id: 'x1', number: 7, bl: 'MAEU123' }];

const EXPENSES = [
  { id: 'e1', supplierId: 's1', expenseAt: 1000, ncf: 'B0100000001', accountCode: '6-02-007-01-03-00', base: 1000, itbis: 180, retentionIsr: 0, retentionItbis: 0, paymentMethod: 'bank' },
];
const PURCHASES = [
  { id: 'p1', supplierId: 's2', purchaseAt: 2000, ncf: 'B0200000001', kind: 'goods', base: 45000, itbis: 8100, retentionIsr: 0, retentionItbis: 0, paymentMethod: 'credit', expedienteId: 'x1', lines: [{ id: 'l1' }, { id: 'l2' }] },
  { id: 'p2', supplierId: 's2', purchaseAt: 3000, ncf: 'B0200000002', kind: 'asset', accountCode: '1-02-001-00-00-00', base: 10000, itbis: 1800, retentionIsr: 0, retentionItbis: 0, paymentMethod: 'bank' },
  { id: 'p3', supplierId: 's1', purchaseAt: 1500, ncf: 'B0200000003', kind: 'service', base: 2000, itbis: 360, retentionIsr: 0, retentionItbis: 0, paymentMethod: 'cash' },
];

test('purchaseNature maps goods/asset/service → mercancia/activo/gasto', () => {
  assert.equal(purchaseNature('goods'), 'mercancia');
  assert.equal(purchaseNature('asset'), 'activo');
  assert.equal(purchaseNature('service'), 'gasto');
});

test('merges expenses + purchases, newest first, with per-nature counts', () => {
  const r = resolvePurchasesExpenses({
    expenses: EXPENSES, purchases: PURCHASES, suppliers: SUPPLIERS, accounts: ACCOUNTS, expedientes: EXPEDIENTES,
  });
  assert.equal(r.count, 4);
  assert.deepEqual(r.rows.map((x) => x.id), ['p2', 'p1', 'p3', 'e1']); // by date desc
  assert.equal(r.counts.all, 4);
  assert.equal(r.counts.gasto, 2);     // e1 (expense) + p3 (legacy service)
  assert.equal(r.counts.mercancia, 1); // p1
  assert.equal(r.counts.activo, 1);    // p2
  // totals over all rows
  assert.equal(r.totals.base, 58000);
  assert.equal(r.totals.itbis, 10440);
  assert.equal(r.totals.total, 68440);
});

test('row shape: source, nature, destination, articles, expediente label', () => {
  const r = resolvePurchasesExpenses({
    expenses: EXPENSES, purchases: PURCHASES, suppliers: SUPPLIERS, accounts: ACCOUNTS, expedientes: EXPEDIENTES,
  });
  const merch = r.rows.find((x) => x.id === 'p1');
  assert.equal(merch.source, 'purchase');
  assert.equal(merch.nature, 'mercancia');
  assert.equal(merch.articles, 2);
  assert.equal(merch.destination, 'Inventario · 2 artículos');
  assert.equal(merch.expedienteLabel, '#7 · MAEU123');
  assert.equal(merch.supplierName, 'Mueblería RD');

  const gasto = r.rows.find((x) => x.id === 'e1');
  assert.equal(gasto.source, 'expense');
  assert.equal(gasto.nature, 'gasto');
  assert.equal(gasto.destination, '6-02-007-01-03-00 · TELEFONO E INTERNET');

  const activo = r.rows.find((x) => x.id === 'p2');
  assert.equal(activo.destination, '1-02-001-00-00-00'); // no name in ACCOUNTS → just the code
});

test('nature filter narrows rows but counts stay over the unfiltered set', () => {
  const r = resolvePurchasesExpenses({
    expenses: EXPENSES, purchases: PURCHASES, suppliers: SUPPLIERS, accounts: ACCOUNTS, nature: 'gasto',
  });
  assert.equal(r.count, 2);
  assert.deepEqual(r.rows.map((x) => x.id).sort(), ['e1', 'p3']);
  assert.equal(r.counts.all, 4);       // chip counts unaffected by the nature filter
  assert.equal(r.counts.mercancia, 1);
});

test('supplier + date-window + query filters', () => {
  const bySupplier = resolvePurchasesExpenses({ expenses: EXPENSES, purchases: PURCHASES, suppliers: SUPPLIERS, supplierId: 's2' });
  assert.deepEqual(bySupplier.rows.map((x) => x.id), ['p2', 'p1']);

  const window = resolvePurchasesExpenses({ expenses: EXPENSES, purchases: PURCHASES, suppliers: SUPPLIERS, start: 1600 });
  assert.deepEqual(window.rows.map((x) => x.id).sort(), ['p1', 'p2']);

  const byNcf = resolvePurchasesExpenses({ expenses: EXPENSES, purchases: PURCHASES, suppliers: SUPPLIERS, query: 'B0200000001' });
  assert.deepEqual(byNcf.rows.map((x) => x.id), ['p1']);

  const bySupplierName = resolvePurchasesExpenses({ expenses: EXPENSES, purchases: PURCHASES, suppliers: SUPPLIERS, query: 'claro' });
  assert.deepEqual(bySupplierName.rows.map((x) => x.id).sort(), ['e1', 'p3']);
});
