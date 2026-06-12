/**
 * Tests for the Gastos module — expense tax computation + the asiento it posts
 * (src/lib/accounting/expense.ts) and the 606 projection
 * (src/core/accounting/expenses.js). Money + the balance invariant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { computeExpenseTaxes, buildExpenseEntry } from '../src/lib/accounting/expense.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';
import { resolve606, resolveExpensesList } from '../src/core/accounting/expenses.js';

const config = resolveAccountingConfig(null); // ITBIS 18, retISR 10, retITBIS 30
function ids() { let n = 0; return () => `id${++n}`; }

test('computeExpenseTaxes: ITBIS only when no retention', () => {
  const t = computeExpenseTaxes({ base: 1000, config });
  assert.equal(t.itbis, 180);
  assert.equal(t.retIsr, 0);
  assert.equal(t.retItbis, 0);
  assert.equal(t.net, 1180);
});

test('computeExpenseTaxes: with both retentions (we are the agent)', () => {
  const t = computeExpenseTaxes({ base: 1000, retainIsr: true, retainItbis: true, config });
  assert.equal(t.itbis, 180);
  assert.equal(t.retIsr, 100);       // 10% of base
  assert.equal(t.retItbis, 54);      // 30% of the 180 ITBIS
  assert.equal(t.net, 1026);         // 1000 + 180 − 100 − 54
});

test('buildExpenseEntry posts a balanced asiento (paid from bank, no retention)', () => {
  const { entry, lines } = buildExpenseEntry({
    newId: ids(), config,
    expense: {
      id: 'e1', accountCode: '6-02-007-01-03-00', description: 'Internet',
      base: 1000, itbis: 180, retentionIsr: 0, retentionItbis: 0,
      paymentMethod: 'bank', supplierId: 's1', ncf: 'B0100000001',
    },
  });
  assert.equal(entry.source, 'expense');
  assert.equal(entry.refTable, 'expenses');
  assert.equal(debitTotal(lines), creditTotal(lines)); // balances
  assert.equal(debitTotal(lines), 1180);
  // gasto debit, itbis credit account debit, bank credit
  assert.equal(lines.find((l) => l.accountCode === '6-02-007-01-03-00').debit, 1000);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.itbisCredit).debit, 180);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.bank).credit, 1180);
});

test('buildExpenseEntry with retentions splits the credit and still balances', () => {
  const { lines } = buildExpenseEntry({
    newId: ids(), config,
    expense: {
      id: 'e2', accountCode: '6-02-001-00-00-00', description: 'Honorarios',
      base: 1000, itbis: 180, retentionIsr: 100, retentionItbis: 54,
      paymentMethod: 'bank', supplierId: 's2', ncf: 'B0100000002',
    },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(creditTotal(lines), 1180);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.bank).credit, 1026);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.isrWithheld).credit, 100);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.itbisWithheld).credit, 54);
});

test('buildExpenseEntry on credit uses suplidores instead of bank', () => {
  const { lines } = buildExpenseEntry({
    newId: ids(), config,
    expense: {
      id: 'e3', accountCode: '6-03-002-00-00-00', description: 'Alquiler',
      base: 5000, itbis: 900, retentionIsr: 0, retentionItbis: 0,
      paymentMethod: 'credit', supplierId: 's3', ncf: 'B0100000003',
    },
  });
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.accountsPayable).credit, 5900);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.bank), undefined);
});

test('buildExpenseEntry refuses an expense without an account', () => {
  assert.throws(() => buildExpenseEntry({
    newId: ids(), config,
    expense: { id: 'e4', accountCode: null, base: 100, itbis: 0, retentionIsr: 0, retentionItbis: 0, paymentMethod: 'bank' },
  }), /cuenta de gasto/);
});

/* -------------------------------- 606 ----------------------------------- */

const SUPPLIERS = [
  { id: 's1', name: 'Claro', rnc: '101010101', kind: 'juridica' },
  { id: 's2', name: 'Arq. Pérez', rnc: '00112345678', kind: 'fisica' },
];
const EXPENSES = [
  { id: 'e1', supplierId: 's1', expenseAt: 1000, ncf: 'B0100000001', base: 1000, itbis: 180, retentionIsr: 0, retentionItbis: 0 },
  { id: 'e2', supplierId: 's2', expenseAt: 2000, ncf: 'B0100000002', base: 1000, itbis: 180, retentionIsr: 100, retentionItbis: 54 },
];

test('resolve606 builds rows + totals from expenses', () => {
  const r = resolve606({ expenses: EXPENSES, suppliers: SUPPLIERS });
  assert.equal(r.count, 2);
  assert.equal(r.rows[0].rnc, '101010101');
  assert.equal(r.totals.base, 2000);
  assert.equal(r.totals.itbis, 360);
  assert.equal(r.totals.retIsr, 100);
  assert.equal(r.totals.retItbis, 54);
  assert.equal(r.totals.total, 2360);
});

test('resolve606 honors the date window', () => {
  const r = resolve606({ expenses: EXPENSES, suppliers: SUPPLIERS, start: 1500 });
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].ncf, 'B0100000002');
});

test('resolve606 folds in expediente costs that carry an NCF', () => {
  const expedientes = [{
    id: 'x1', liquidatedAt: 1500,
    costs: [
      { id: 'c1', concept: 'agenciamiento', supplierId: 's1', ncf: 'B0100000099', amount: 11800, itbis: 1800, paymentMethod: 'credit' },
      { id: 'c2', concept: 'seguro', supplierId: 's2', ncf: 'B0100000100', amount: 2360, itbis: 360 },
      { id: 'c3', concept: 'tasaDga', amount: 5000, itbis: 0 }, // no NCF → not a 606 doc
    ],
  }];
  const r = resolve606({ expedientes, suppliers: SUPPLIERS });
  assert.equal(r.count, 2);
  const agencia = r.rows.find((x) => x.ncf === 'B0100000099');
  assert.equal(agencia.base, 10000);   // amount net of its ITBIS
  assert.equal(agencia.itbis, 1800);
  assert.equal(agencia.tipo606, '02'); // servicios
  assert.equal(agencia.pay, 'credit');
  assert.equal(r.rows.find((x) => x.ncf === 'B0100000100').tipo606, '11'); // seguros
  assert.equal(r.totals.itbis, 2160);
});

test('resolve606 stamps the DGII tipo de bienes/servicios per doc', () => {
  const r = resolve606({
    expenses: [{ id: 'g1', supplierId: 's1', expenseAt: 1000, ncf: 'B01', base: 100, itbis: 18, accountCode: '6-01-001-01-00-00', paymentMethod: 'cash' }],
    purchases: [
      { id: 'p1', supplierId: 's1', purchaseAt: 1000, ncf: 'B02', base: 100, itbis: 18, kind: 'goods', paymentMethod: 'credit' },
      { id: 'p2', supplierId: 's1', purchaseAt: 1000, ncf: 'B03', base: 100, itbis: 18, kind: 'asset', paymentMethod: 'bank' },
    ],
    suppliers: SUPPLIERS,
  });
  assert.equal(r.rows.find((x) => x.ncf === 'B01').tipo606, '01'); // gastos de personal
  assert.equal(r.rows.find((x) => x.ncf === 'B02').tipo606, '09'); // costo de venta
  assert.equal(r.rows.find((x) => x.ncf === 'B03').tipo606, '10'); // adquisición de activos
});

test('resolveExpensesList joins supplier + account names, newest first', () => {
  const accounts = [{ code: '6-02-007-01-03-00', name: 'TELEFONO E INTERNET' }];
  const withAcct = EXPENSES.map((e) => ({ ...e, accountCode: '6-02-007-01-03-00', paymentMethod: 'bank' }));
  const r = resolveExpensesList({ expenses: withAcct, suppliers: SUPPLIERS, accounts });
  assert.equal(r.count, 2);
  assert.equal(r.rows[0].expense.id, 'e2'); // newest first
  assert.equal(r.rows[0].accountName, 'TELEFONO E INTERNET');
  assert.equal(r.totals.total, 2360);
});
