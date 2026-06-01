/**
 * Tests for the Facturación module — the sale asiento at delivery
 * (src/lib/accounting/sale.ts) and the 607 + ITBIS-liquidation projections
 * (src/core/accounting/sales607.js). Money + the balance invariant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { buildSaleEntry, depositApplied } from '../src/lib/accounting/sale.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';
import { resolveSales607, resolveItbisLiquidation } from '../src/core/accounting/sales607.js';

const config = resolveAccountingConfig(null);
const M = config.postingMap;
function ids() { let n = 0; return () => `id${++n}`; }

test('depositApplied clamps to [0, total]', () => {
  assert.equal(depositApplied(5000, 11800), 5000);
  assert.equal(depositApplied(20000, 11800), 11800); // capped at total
  assert.equal(depositApplied(-100, 11800), 0);
});

test('buildSaleEntry: deposit + receivable + revenue + ITBIS balances', () => {
  const { entry, lines } = buildSaleEntry({
    newId: ids(), config,
    sale: { id: 'sp1', quoteId: 'q1', customerId: 'c1', base: 10000, itbis: 1800, deposit: 5000, ncf: 'B0200000001' },
  });
  assert.equal(entry.source, 'sale');
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(debitTotal(lines), 11800);
  assert.equal(lines.find((l) => l.accountCode === M.customerDeposits).debit, 5000);
  assert.equal(lines.find((l) => l.accountCode === M.accountsReceivable).debit, 6800);
  assert.equal(lines.find((l) => l.accountCode === M.salesLocal).credit, 10000);
  assert.equal(lines.find((l) => l.accountCode === M.itbisPayable).credit, 1800);
});

test('buildSaleEntry: no deposit → full receivable', () => {
  const { lines } = buildSaleEntry({
    newId: ids(), config,
    sale: { id: 'sp2', base: 10000, itbis: 1800, deposit: 0 },
  });
  assert.equal(lines.find((l) => l.accountCode === M.accountsReceivable).debit, 11800);
  assert.equal(lines.find((l) => l.accountCode === M.customerDeposits), undefined);
});

test('buildSaleEntry: deposit covers the whole sale → no receivable', () => {
  const { lines } = buildSaleEntry({
    newId: ids(), config,
    sale: { id: 'sp3', base: 10000, itbis: 1800, deposit: 11800 },
  });
  assert.equal(lines.find((l) => l.accountCode === M.customerDeposits).debit, 11800);
  assert.equal(lines.find((l) => l.accountCode === M.accountsReceivable), undefined);
  assert.equal(debitTotal(lines), creditTotal(lines));
});

test('buildSaleEntry refuses a zero-amount sale', () => {
  assert.throws(() => buildSaleEntry({
    newId: ids(), config, sale: { id: 'sp4', base: 0, itbis: 0 },
  }), /monto a facturar/);
});

/* -------------------------------- 607 ----------------------------------- */

const CUSTOMERS = new Map([
  ['c1', { id: 'c1', name: 'Eduardo García', rnc: '00112345678' }],
]);
const POSTINGS = [
  { id: 'sp1', customerId: 'c1', postedAt: 1000, ncf: 'B0200000001', rnc: '00112345678', base: 10000, itbis: 1800, total: 11800 },
  { id: 'sp2', customerId: null, postedAt: 2000, ncf: 'B0200000002', base: 5000, itbis: 900, total: 5900 },
];

test('resolveSales607 builds rows + totals', () => {
  const r = resolveSales607({ salesPostings: POSTINGS, customersById: CUSTOMERS });
  assert.equal(r.count, 2);
  assert.equal(r.rows[0].rnc, '00112345678');
  assert.equal(r.rows[0].name, 'Eduardo García');
  assert.equal(r.totals.base, 15000);
  assert.equal(r.totals.itbis, 2700);
  assert.equal(r.totals.total, 17700);
});

test('resolveItbisLiquidation: débito − crédito, a pagar / a favor', () => {
  const expenses = [
    { expenseAt: 1500, itbis: 1000, itbisCreditable: true },
    { expenseAt: 1600, itbis: 500, itbisCreditable: false }, // not creditable → excluded
  ];
  const r = resolveItbisLiquidation({ salesPostings: POSTINGS, expenses });
  assert.equal(r.debitoFiscal, 2700); // 1800 + 900
  assert.equal(r.creditoFiscal, 1000); // only the creditable one
  assert.equal(r.saldo, 1700);
  assert.equal(r.aPagar, 1700);
  assert.equal(r.aFavor, 0);
});

test('resolveItbisLiquidation: crédito > débito ⇒ saldo a favor', () => {
  const r = resolveItbisLiquidation({
    salesPostings: [{ postedAt: 1000, itbis: 500 }],
    expenses: [{ expenseAt: 1000, itbis: 1200, itbisCreditable: true }],
  });
  assert.equal(r.saldo, -700);
  assert.equal(r.aPagar, 0);
  assert.equal(r.aFavor, 700);
});
