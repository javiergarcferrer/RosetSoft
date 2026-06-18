/**
 * Tests for the Facturación module — the sale asiento at delivery
 * (src/lib/accounting/sale.ts) and the 607 + ITBIS-liquidation projections
 * (src/core/accounting/sales607.js). Money + the balance invariant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { buildSaleEntry, buildCreditNoteEntry, depositApplied } from '../src/lib/accounting/sale.js';
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

/* ---------------------------- nota de crédito --------------------------- */

test('buildCreditNoteEntry (full cancel) exactly mirrors the sale asiento', () => {
  const sale = buildSaleEntry({
    newId: ids(), config,
    sale: { id: 'sp1', customerId: 'c1', base: 10000, itbis: 1800, deposit: 5000, ncf: 'E310000000001' },
  });
  const nc = buildCreditNoteEntry({
    newId: ids(), config,
    note: { id: 'nc1', customerId: 'c1', base: 10000, itbis: 1800, depositToRestore: 5000, ncf: 'E340000000001' },
  });
  // Balanced, and every sale debit is now an NC credit of the same size.
  assert.equal(debitTotal(nc.lines), creditTotal(nc.lines));
  assert.equal(debitTotal(nc.lines), 11800);
  assert.equal(nc.lines.find((l) => l.accountCode === M.salesLocal).debit, 10000);
  assert.equal(nc.lines.find((l) => l.accountCode === M.itbisPayable).debit, 1800);
  assert.equal(nc.lines.find((l) => l.accountCode === M.customerDeposits).credit, 5000);
  assert.equal(nc.lines.find((l) => l.accountCode === M.accountsReceivable).credit, 6800);
  // Net of sale + NC is zero per account.
  const net = new Map();
  for (const l of [...sale.lines, ...nc.lines]) {
    net.set(l.accountCode, (net.get(l.accountCode) || 0) + (l.debit || 0) - (l.credit || 0));
  }
  for (const v of net.values()) assert.equal(Math.round(v * 100) / 100, 0);
});

test('buildCreditNoteEntry (partial, no deposit) credits revenue + ITBIS against CxC', () => {
  const { lines } = buildCreditNoteEntry({
    newId: ids(), config,
    note: { id: 'nc2', customerId: 'c1', base: 2500, itbis: 450, ncf: 'E340000000002' },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.salesLocal).debit, 2500);
  assert.equal(lines.find((l) => l.accountCode === M.itbisPayable).debit, 450);
  assert.equal(lines.find((l) => l.accountCode === M.accountsReceivable).credit, 2950);
  assert.equal(lines.find((l) => l.accountCode === M.customerDeposits), undefined);
});

test('buildCreditNoteEntry refuses a zero-amount note', () => {
  assert.throws(() => buildCreditNoteEntry({
    newId: ids(), config, note: { id: 'nc3', base: 0, itbis: 0 },
  }), /acreditar/);
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

test('resolveSales607 query filters rows + totals (exports use no query)', () => {
  const byNcf = resolveSales607({ salesPostings: POSTINGS, customersById: CUSTOMERS, query: 'b0200000002' });
  assert.equal(byNcf.count, 1);
  assert.equal(byNcf.rows[0].ncf, 'B0200000002');
  const byName = resolveSales607({ salesPostings: POSTINGS, customersById: CUSTOMERS, query: 'eduardo' });
  assert.equal(byName.count, 1);
  assert.equal(byName.totals.total, 11800);
});
