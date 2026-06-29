/**
 * Tests for the accounting core — the double-entry posting rules
 * (src/lib/accounting/ledger.ts), the chart-of-accounts structure
 * (src/lib/accounting/chart.ts), and the ledger ViewModels
 * (src/core/accounting/ledger.js).
 *
 * This is data-integrity territory (money + the balance invariant), exactly
 * what the project's test policy covers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classOf, natureForClass, buildChartIndex, chartRoots, leafCodesUnder,
  postableAccounts,
} from '../src/lib/accounting/chart.js';
import {
  round2, debitTotal, creditTotal, entryImbalance, isBalanced, assertBalanced,
  naturalBalance, buildJournalEntry, buildReversalEntry,
} from '../src/lib/accounting/ledger.js';
import {
  resolveTrialBalance, resolveBalanceSheet, resolveIncomeStatement,
  resolveBalanceSheetComparison, resolveIncomeStatementComparison,
  resolveJournal, resolveAccountLedger, resolveChartTree, accountRawBalances,
} from '../src/core/accounting/ledger.js';

/* ----------------------------- fixture chart ---------------------------- */

const ACCOUNTS = [
  { code: '1', class: 1, nature: 'debit', parentCode: null, level: 1, isPostable: false, name: 'ACTIVOS', sortOrder: 1 },
  { code: '1-1', class: 1, nature: 'debit', parentCode: '1', level: 2, isPostable: false, name: 'CAJA Y BANCOS', sortOrder: 2 },
  { code: '1-1-1', class: 1, nature: 'debit', parentCode: '1-1', level: 3, isPostable: true, name: 'CAJA', sortOrder: 3 },
  { code: '1-1-2', class: 1, nature: 'debit', parentCode: '1-1', level: 3, isPostable: true, name: 'BANCO', sortOrder: 4 },
  { code: '2', class: 2, nature: 'credit', parentCode: null, level: 1, isPostable: false, name: 'PASIVOS', sortOrder: 5 },
  { code: '2-1', class: 2, nature: 'credit', parentCode: '2', level: 2, isPostable: true, name: 'ITBIS POR PAGAR', sortOrder: 6 },
  { code: '3', class: 3, nature: 'credit', parentCode: null, level: 1, isPostable: false, name: 'PATRIMONIO', sortOrder: 7 },
  { code: '3-1', class: 3, nature: 'credit', parentCode: '3', level: 2, isPostable: true, name: 'CAPITAL', sortOrder: 8 },
  { code: '4', class: 4, nature: 'credit', parentCode: null, level: 1, isPostable: false, name: 'INGRESOS', sortOrder: 9 },
  { code: '4-1', class: 4, nature: 'credit', parentCode: '4', level: 2, isPostable: true, name: 'VENTAS', sortOrder: 10 },
  { code: '5', class: 5, nature: 'debit', parentCode: null, level: 1, isPostable: false, name: 'COSTOS', sortOrder: 11 },
  { code: '5-1', class: 5, nature: 'debit', parentCode: '5', level: 2, isPostable: true, name: 'COSTO DE VENTA', sortOrder: 12 },
  { code: '6', class: 6, nature: 'debit', parentCode: null, level: 1, isPostable: false, name: 'GASTOS', sortOrder: 13 },
  { code: '6-1', class: 6, nature: 'debit', parentCode: '6', level: 2, isPostable: true, name: 'ALQUILER', sortOrder: 14 },
];

// Deterministic id factory so assertions can be stable.
function idFactory() {
  let n = 0;
  return () => `id${++n}`;
}

// Build the canonical scenario: opening capital, a sale (with ITBIS) at
// delivery, its cost of sale, and a rent expense.
function scenario() {
  const newId = idFactory();
  const mk = (postedAt, source, lines) =>
    buildJournalEntry({ newId, postedAt, source, lines });

  const A = mk(1000, 'opening', [
    { accountCode: '1-1-2', debit: 100000 },
    { accountCode: '3-1', credit: 100000 },
  ]);
  const B = mk(2000, 'sale', [
    { accountCode: '1-1-2', debit: 11800 },
    { accountCode: '4-1', credit: 10000 },
    { accountCode: '2-1', credit: 1800 },
  ]);
  const C = mk(3000, 'sale', [
    { accountCode: '5-1', debit: 6000 },
    { accountCode: '1-1-2', credit: 6000 },
  ]);
  const D = mk(4000, 'expense', [
    { accountCode: '6-1', debit: 2000 },
    { accountCode: '1-1-2', credit: 2000 },
  ]);

  const entries = [A.entry, B.entry, C.entry, D.entry];
  const lines = [...A.lines, ...B.lines, ...C.lines, ...D.lines];
  return { entries, lines };
}

/* ------------------------------- chart ---------------------------------- */

test('classOf reads the first segment as the class', () => {
  assert.equal(classOf('1-01-001-01-00-00'), 1);
  assert.equal(classOf('6-08-009-00-00-00'), 6);
  assert.equal(classOf(''), 0);
});

test('natureForClass: 1/5/6 debit, 2/3/4 credit', () => {
  assert.equal(natureForClass(1), 'debit');
  assert.equal(natureForClass(5), 'debit');
  assert.equal(natureForClass(6), 'debit');
  assert.equal(natureForClass(2), 'credit');
  assert.equal(natureForClass(3), 'credit');
  assert.equal(natureForClass(4), 'credit');
});

test('chartRoots returns the class roots in class order', () => {
  const idx = buildChartIndex(ACCOUNTS);
  assert.deepEqual(chartRoots(idx).map((r) => r.class), [1, 2, 3, 4, 5, 6]);
});

test('leafCodesUnder returns the postable leaves of a subtree', () => {
  const idx = buildChartIndex(ACCOUNTS);
  assert.deepEqual(leafCodesUnder(idx, '1'), ['1-1-1', '1-1-2']);
  assert.deepEqual(leafCodesUnder(idx, '1-1-2'), ['1-1-2']); // a leaf returns itself
  assert.deepEqual(leafCodesUnder(idx, '2'), ['2-1']);
});

test('postableAccounts filters to leaves', () => {
  // 1-1-1, 1-1-2, 2-1, 3-1, 4-1, 5-1, 6-1 = 7 postable leaves.
  assert.equal(postableAccounts(ACCOUNTS).length, 7);
});

/* ------------------------------- posting -------------------------------- */

test('round2 rounds to cents', () => {
  assert.equal(round2(1.236), 1.24);
  assert.equal(round2(2.341), 2.34);
  assert.equal(round2(10 / 3), 3.33);
  assert.equal(round2(null), 0);
});

test('debit/credit totals and imbalance', () => {
  const lines = [{ accountCode: 'a', debit: 100 }, { accountCode: 'b', credit: 100 }];
  assert.equal(debitTotal(lines), 100);
  assert.equal(creditTotal(lines), 100);
  assert.equal(entryImbalance(lines), 0);
  assert.equal(isBalanced(lines), true);
});

test('assertBalanced throws on an unbalanced entry', () => {
  assert.throws(() => assertBalanced([
    { accountCode: 'a', debit: 100 },
    { accountCode: 'b', credit: 90 },
  ]), /no cuadra/);
});

test('assertBalanced rejects a single-line entry', () => {
  assert.throws(() => assertBalanced([{ accountCode: 'a', debit: 100 }]), /al menos dos/);
});

test('assertBalanced rejects a line with both debit and credit', () => {
  assert.throws(() => assertBalanced([
    { accountCode: 'a', debit: 100, credit: 100 },
    { accountCode: 'b', credit: 100 },
  ]), /débito y crédito/);
});

test('assertBalanced rejects a line with neither debit nor credit', () => {
  assert.throws(() => assertBalanced([
    { accountCode: 'a', debit: 100 },
    { accountCode: 'b' },
  ]), /débito o un crédito/);
});

test('assertBalanced requires an account on every line', () => {
  assert.throws(() => assertBalanced([
    { accountCode: '', debit: 100 },
    { accountCode: 'b', credit: 100 },
  ]), /necesita una cuenta/);
});

test('assertBalanced validates on ROUNDED amounts — a sub-cent line is rejected', () => {
  // 0.004 rounds to 0 cents on persist, so it carries no real debit: it must be
  // rejected here (it would otherwise pass and write a phantom-account line).
  assert.throws(() => assertBalanced([
    { accountCode: 'a', debit: 0.004 },
    { accountCode: 'b', credit: 0.004 },
  ]), /débito o un crédito/);
});

test('naturalBalance re-signs by nature', () => {
  assert.equal(naturalBalance(50, 'debit'), 50);    // asset up on debit
  assert.equal(naturalBalance(50, 'credit'), -50);  // a credit account with net debit is negative
  assert.equal(naturalBalance(-30, 'credit'), 30);  // income up on credit
});

test('buildJournalEntry assigns ids, links lines, stamps sortOrder', () => {
  const newId = idFactory();
  const { entry, lines } = buildJournalEntry({
    newId, postedAt: 5, source: 'manual', memo: 'test',
    lines: [{ accountCode: 'a', debit: 100 }, { accountCode: 'b', credit: 100 }],
  });
  assert.equal(entry.id, 'id1');
  assert.equal(entry.source, 'manual');
  assert.equal(entry.postedAt, 5);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].entryId, 'id1');
  assert.equal(lines[0].sortOrder, 1);
  assert.equal(lines[1].sortOrder, 2);
  assert.equal(lines[0].debit, 100);
  assert.equal(lines[1].credit, 100);
});

test('buildJournalEntry refuses to build an unbalanced entry', () => {
  const newId = idFactory();
  assert.throws(() => buildJournalEntry({
    newId, lines: [{ accountCode: 'a', debit: 100 }, { accountCode: 'b', credit: 50 }],
  }), /no cuadra/);
});

test('buildReversalEntry swaps debits/credits and links back', () => {
  const newId = idFactory();
  const original = { id: 'orig1', profileId: 'team', number: 7, postedAt: 100, source: 'sale', refTable: 'sales_postings', refId: 'sp1' };
  const originalLines = [
    { accountCode: '1-1', debit: 1180, credit: 0 },
    { accountCode: '4-1', debit: 0, credit: 1000 },
    { accountCode: '2-1', debit: 0, credit: 180 },
  ];
  const { entry, lines } = buildReversalEntry({ newId, original, originalLines });
  assert.equal(entry.reversesId, 'orig1');
  assert.equal(entry.source, 'adjustment');
  assert.equal(debitTotal(lines), creditTotal(lines)); // still balances
  assert.equal(lines.find((l) => l.accountCode === '1-1').credit, 1180); // debit→credit
  assert.equal(lines.find((l) => l.accountCode === '4-1').debit, 1000);  // credit→debit
});

/* ------------------------------ ViewModels ------------------------------ */

test('accountRawBalances sums by account, honoring a date window', () => {
  const { entries, lines } = scenario();
  const all = accountRawBalances(lines);
  assert.equal(all.get('1-1-2').debit, 111800);
  assert.equal(all.get('1-1-2').credit, 8000);
  // Window that excludes the opening entry (postedAt 1000).
  const windowed = accountRawBalances(lines, { entries, start: 1500 });
  assert.equal(windowed.get('1-1-2').debit, 11800);
});

test('resolveTrialBalance balances (Σ debit = Σ credit)', () => {
  const { entries, lines } = scenario();
  const tb = resolveTrialBalance({ accounts: ACCOUNTS, lines, entries });
  assert.equal(tb.totalDebit, 119800);
  assert.equal(tb.totalCredit, 119800);
  assert.equal(tb.balanced, true);
  const banco = tb.rows.find((r) => r.code === '1-1-2');
  assert.equal(banco.balance, 103800);
});

test('resolveIncomeStatement computes gross and net profit', () => {
  const { entries, lines } = scenario();
  const is = resolveIncomeStatement({ accounts: ACCOUNTS, lines, entries });
  assert.equal(is.totalIncome, 10000);
  assert.equal(is.totalCosts, 6000);
  assert.equal(is.grossProfit, 4000);
  assert.equal(is.totalExpenses, 2000);
  assert.equal(is.netIncome, 2000);
});

test('resolveBalanceSheet balances: Activo = Pasivo + Patrimonio + Resultado', () => {
  const { entries, lines } = scenario();
  const bs = resolveBalanceSheet({ accounts: ACCOUNTS, lines, entries, asOf: 5000 });
  assert.equal(bs.totalAssets, 103800);
  assert.equal(bs.totalLiabilities, 1800);
  assert.equal(bs.equityBooked, 100000);
  assert.equal(bs.netIncome, 2000);
  assert.equal(bs.totalEquity, 102000);
  assert.equal(bs.totalLiabEquity, 103800);
  assert.equal(bs.balanced, true);
  assert.equal(bs.difference, 0);
});

test('resolveIncomeStatementComparison aligns two periods by account code', () => {
  const { entries, lines } = scenario();
  // P1 captures only the sale (@2000); P2 only the cost (@3000) + expense (@4000).
  const cmp = resolveIncomeStatementComparison({
    accounts: ACCOUNTS, lines, entries,
    periods: [
      { label: 'P1', start: 1500, end: 2500 },
      { label: 'P2', start: 2500, end: 4500 },
    ],
  });
  assert.deepEqual(cmp.totalIncome, [10000, 0]);
  assert.deepEqual(cmp.totalCosts, [0, 6000]);
  assert.deepEqual(cmp.totalExpenses, [0, 2000]);
  assert.deepEqual(cmp.grossProfit, [10000, -6000]);
  assert.deepEqual(cmp.netIncome, [10000, -8000]);
  // Every node carries one amount per period, aligned by code.
  assert.deepEqual(cmp.income.amounts, [10000, 0]);
  const ventas = cmp.income.children.find((c) => c.code === '4-1');
  assert.deepEqual(ventas.amounts, [10000, 0]);
});

test('resolveIncomeStatementComparison with ONE period matches the single statement', () => {
  const { entries, lines } = scenario();
  const single = resolveIncomeStatement({ accounts: ACCOUNTS, lines, entries });
  const cmp = resolveIncomeStatementComparison({
    accounts: ACCOUNTS, lines, entries, periods: [{ label: 'todo', start: null, end: null }],
  });
  assert.equal(cmp.totalIncome[0], single.totalIncome);
  assert.equal(cmp.grossProfit[0], single.grossProfit);
  assert.equal(cmp.netIncome[0], single.netIncome);
  assert.equal(cmp.income.amounts[0], single.income.amount);
});

test('resolveBalanceSheetComparison keeps every cut-off column balanced', () => {
  const { entries, lines } = scenario();
  const bcmp = resolveBalanceSheetComparison({
    accounts: ACCOUNTS, lines, entries,
    periods: [
      { label: 'hoy', asOf: 5000 },  // all entries
      { label: 'medio', asOf: 2500 }, // opening + sale only
    ],
  });
  assert.deepEqual(bcmp.totalAssets, [103800, 111800]);
  assert.deepEqual(bcmp.totalLiabilities, [1800, 1800]);
  assert.deepEqual(bcmp.equityBooked, [100000, 100000]);
  assert.deepEqual(bcmp.netIncome, [2000, 10000]);
  assert.deepEqual(bcmp.totalEquity, [102000, 110000]);
  assert.deepEqual(bcmp.totalLiabEquity, [103800, 111800]);
  assert.deepEqual(bcmp.balanced, [true, true]);
  assert.deepEqual(bcmp.difference, [0, 0]);
});

test('resolveJournal lists entries newest-first with balanced totals', () => {
  const { entries, lines } = scenario();
  const j = resolveJournal({ entries, lines });
  assert.equal(j.length, 4);
  assert.equal(j[0].entry.postedAt, 4000); // newest first
  assert.equal(j[3].entry.postedAt, 1000);
  for (const row of j) assert.equal(row.debit, row.credit); // each entry balances
});

test('resolveChartTree rolls balances up the tree and keeps zero nodes', () => {
  const { entries, lines } = scenario();
  const { roots } = resolveChartTree({ accounts: ACCOUNTS, lines, entries });
  // Every class root is present (no pruning), in class order.
  assert.deepEqual(roots.map((r) => r.class), [1, 2, 3, 4, 5, 6]);
  const activos = roots.find((r) => r.code === '1');
  assert.equal(activos.amount, 103800); // Σ of its leaves (CAJA 0 + BANCO 103800)
  const cajaYBancos = activos.children.find((c) => c.code === '1-1');
  assert.equal(cajaYBancos.amount, 103800);
  const caja = cajaYBancos.children.find((c) => c.code === '1-1-1');
  assert.equal(caja.amount, 0); // a zero-movement leaf is NOT pruned (still selectable)
  const banco = cajaYBancos.children.find((c) => c.code === '1-1-2');
  assert.equal(banco.amount, 103800);
});

test('resolveAccountLedger gives a running balance in date order', () => {
  const { entries, lines } = scenario();
  const led = resolveAccountLedger({ accounts: ACCOUNTS, entries, lines, accountCode: '1-1-2' });
  assert.equal(led.rows.length, 4);
  assert.equal(led.rows[0].balance, 100000);
  assert.equal(led.rows[1].balance, 111800);
  assert.equal(led.rows[2].balance, 105800);
  assert.equal(led.rows[3].balance, 103800);
  assert.equal(led.balance, 103800);
});
