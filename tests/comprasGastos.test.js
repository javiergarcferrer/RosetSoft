/**
 * Tests for the unified Compras y gastos list (src/core/accounting/compras.js):
 * the merge of expenses + purchases into one row shape discriminated by nature,
 * the nature/supplier/date/query filters, per-nature chip counts and totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePurchasesExpenses, resolvePurchaseExpenseDetail, purchaseNature } from '../src/core/accounting/compras.js';

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

test('resolvePurchaseExpenseDetail: a line-bill projects per-line accounts + tax labels', () => {
  const purchase = {
    id: 'pb', supplierId: 's1', purchaseAt: 1000, ncf: 'E310000006621',
    kind: 'service', lineMode: true, accountCode: null, description: 'Servicios varios',
    base: 7000, itbis: 1260, retentionIsr: 0, retentionItbis: 270, paymentMethod: 'credit',
    lines: [
      { id: 'a', description: 'Mantenimiento', accountCode: '6-02-007-01-03-00', qty: 1, unitPrice: 5000, base: 5000, itbis: 900, taxIds: ['itbis18', 'retItbis30'] },
      { id: 'b', description: 'Materiales', accountCode: '6-99', qty: 2, unitPrice: 1000, base: 2000, itbis: 360, taxIds: ['itbis18'] },
    ],
  };
  const d = resolvePurchaseExpenseDetail({ purchase, suppliers: SUPPLIERS, accounts: ACCOUNTS, items: [], expedientes: [] });
  assert.equal(d.isLineBill, true);
  assert.equal(d.nature, 'gasto');                 // service → gasto nature
  assert.equal(d.lines.length, 2);
  assert.equal(d.lines[0].accountCode, '6-02-007-01-03-00');
  assert.equal(d.lines[0].accountName, 'TELEFONO E INTERNET');
  assert.equal(d.lines[0].base, 5000);
  assert.deepEqual(d.lines[0].taxLabels, ['ITBIS 18%', 'Ret. ITBIS 30%']);
  assert.equal(d.lines[1].base, 2000);
  assert.equal(d.total, 8260);                     // base 7000 + itbis 1260
  assert.equal(d.net, 7990);                       // − ret. ITBIS 270
  assert.match(d.destination, /2 líneas/);
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

test('resolvePurchaseExpenseDetail: mercancía purchase → lines + money + inventory flag', () => {
  const purchase = {
    id: 'p1', number: 3, supplierId: 's2', purchaseAt: 2000, ncf: 'B0200000001', kind: 'goods',
    base: 45000, itbis: 8100, retentionIsr: 0, retentionItbis: 0, paymentMethod: 'credit', expedienteId: 'x1',
    lines: [{ id: 'l1', itemId: 'i1', name: 'Sofá', reference: '141', qty: 2, cost: 30000 }, { id: 'l2', itemId: null, name: 'Puff', reference: '', qty: 3, cost: 15000 }],
  };
  const d = resolvePurchaseExpenseDetail({
    purchase, suppliers: SUPPLIERS, accounts: ACCOUNTS, expedientes: EXPEDIENTES,
    items: [{ id: 'i1', name: 'Sofá Togo', sku: '141' }],
  });
  assert.equal(d.source, 'purchase');
  assert.equal(d.nature, 'mercancia');
  assert.equal(d.reversesInventory, true);
  assert.equal(d.supplierName, 'Mueblería RD');
  assert.equal(d.destination, 'Inventario · 2 artículos');
  assert.equal(d.expediente.id, 'x1');
  assert.equal(d.expediente.label, '#7 · MAEU123');
  assert.equal(d.total, 53100);
  assert.equal(d.net, 53100);
  assert.equal(d.lines.length, 2);
  assert.equal(d.lines[0].name, 'Sofá Togo');   // current item name wins over the stored line name
  assert.equal(d.lines[0].unitCost, 15000);
  assert.equal(d.lines[1].inInventory, false);  // free-text line, item since deleted
  // Document header fields
  assert.equal(d.supplierRnc, '00112345678');
  assert.equal(d.tipo606, '09');                 // goods → costo de venta
  assert.equal(d.tipo606Label, 'Compras y gastos que formarán parte del costo de venta');
  assert.equal(d.paymentStatus, 'unpaid');       // credit, not yet paid → por pagar
});

test('resolvePurchaseExpenseDetail: gasto → no inventory, net nets the retentions', () => {
  const expense = { id: 'e9', supplierId: 's1', expenseAt: 1000, ncf: 'B01', accountCode: '6-02-007-01-03-00', description: 'Honorarios', base: 1000, itbis: 180, retentionIsr: 100, retentionItbis: 54, paymentMethod: 'bank' };
  const d = resolvePurchaseExpenseDetail({ expense, suppliers: SUPPLIERS, accounts: ACCOUNTS });
  assert.equal(d.source, 'expense');
  assert.equal(d.nature, 'gasto');
  assert.equal(d.reversesInventory, false);
  assert.equal(d.lines.length, 0);
  assert.equal(d.destination, '6-02-007-01-03-00 · TELEFONO E INTERNET');
  assert.equal(d.total, 1180);
  assert.equal(d.net, 1026); // 1000 + 180 − 100 − 54
  assert.equal(d.tipo606, '02');         // class-6 service account → trabajos/suministros/servicios
  assert.equal(d.paymentStatus, 'paid'); // bank → settles on posting
});

test('resolvePurchaseExpenseDetail: returns null when neither row exists', () => {
  assert.equal(resolvePurchaseExpenseDetail({ suppliers: SUPPLIERS }), null);
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

test('surfaces POSTED-expediente cost-sheet rows (read-only, linked, nature=expediente)', () => {
  const expedientes = [{
    id: 'x9', number: 12, bl: 'BL999', status: 'posted', liquidatedAt: 2500,
    costs: [
      { id: 'c1', concept: 'transporte', supplierId: 's1', ncf: 'B0200000099', amount: 1180, itbis: 180, paymentMethod: 'bank' },
      { id: 'c2', concept: 'agenciamiento', label: 'Agente aduanal', amount: 500, itbis: 0, paymentMethod: 'credit' },
    ],
  }];
  const r = resolvePurchasesExpenses({ expenses: [], purchases: [], suppliers: SUPPLIERS, accounts: ACCOUNTS, expedientes });
  assert.equal(r.count, 2);
  assert.equal(r.counts.expediente, 2);

  const t = r.rows.find((x) => x.id === 'expcost-x9-c1');
  assert.equal(t.source, 'expediente-cost');
  assert.equal(t.nature, 'expediente');
  assert.equal(t.readOnly, true);
  assert.equal(t.expedienteId, 'x9');
  assert.equal(t.expedienteLabel, '#12 · BL999');
  assert.equal(t.supplierName, 'Claro');
  assert.equal(t.ncf, 'B0200000099');
  assert.equal(t.total, 1180);
  assert.equal(t.itbis, 180);
  assert.equal(t.base, 1000);                    // gross − itbis
  assert.equal(t.destination, 'Transporte terrestre');

  const a = r.rows.find((x) => x.id === 'expcost-x9-c2');
  assert.equal(a.destination, 'Agente aduanal'); // custom label wins over the concept
  assert.equal(a.total, 500);
});

test('DRAFT expedientes contribute no cost rows (no asiento yet)', () => {
  const expedientes = [{ id: 'xd', number: 1, status: 'draft', costs: [{ id: 'c', concept: 'transporte', amount: 100, itbis: 0 }] }];
  const r = resolvePurchasesExpenses({ expenses: [], purchases: [], suppliers: SUPPLIERS, expedientes });
  assert.equal(r.count, 0);
  assert.equal(r.counts.expediente, 0);
});

test('the Expediente nature filters to cost rows only; chip counts stay over the full set', () => {
  const expedientes = [{ id: 'x9', number: 12, status: 'posted', liquidatedAt: 2500, costs: [{ id: 'c1', concept: 'transporte', amount: 100, itbis: 0 }] }];
  const r = resolvePurchasesExpenses({ expenses: EXPENSES, purchases: PURCHASES, suppliers: SUPPLIERS, accounts: ACCOUNTS, expedientes, nature: 'expediente' });
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].id, 'expcost-x9-c1');
  assert.equal(r.counts.all, 5);   // 4 docs + 1 cost row, unaffected by the filter
  assert.equal(r.counts.expediente, 1);
});
