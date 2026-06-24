/**
 * Presupuesto vs. real — annual budget against the ledger actual per account,
 * variance + favorable direction (income over plan good; expense under plan good).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBudgetVariance } from '../src/core/accounting/budgets.js';

const accounts = [
  { code: '4-01-001-01-00-00', name: 'Ventas', class: 4, nature: 'credit', isPostable: true },
  { code: '6-01-001-01-00-00', name: 'Salarios', class: 6, nature: 'debit', isPostable: true },
  { code: '6-02-007-01-03-00', name: 'Internet', class: 6, nature: 'debit', isPostable: true },
];
const Y = 2026;
const T = Date.UTC(Y, 3, 15);
const entries = [{ id: 'e1', postedAt: T }];
const lines = [
  { entryId: 'e1', accountCode: '4-01-001-01-00-00', debit: 0, credit: 120000 }, // income 120k
  { entryId: 'e1', accountCode: '6-01-001-01-00-00', debit: 90000, credit: 0 },  // salaries 90k
];
const budgets = [
  { accountCode: '4-01-001-01-00-00', year: Y, amount: 100000 }, // planned 100k income
  { accountCode: '6-01-001-01-00-00', year: Y, amount: 80000 },  // planned 80k salaries
  { accountCode: '6-02-007-01-03-00', year: Y, amount: 12000 },  // planned internet, no actual
];

test('variance + favorable per account', () => {
  const r = resolveBudgetVariance({ accounts, lines, entries, budgets, year: Y });
  const byCode = Object.fromEntries(r.sections.flatMap((s) => s.rows).map((x) => [x.code, x]));
  // income: actual 120k vs budget 100k → +20k favorable
  assert.equal(byCode['4-01-001-01-00-00'].actual, 120000);
  assert.equal(byCode['4-01-001-01-00-00'].variance, 20000);
  assert.equal(byCode['4-01-001-01-00-00'].favorable, true);
  // salaries: actual 90k vs budget 80k → +10k OVER (unfavorable for an expense)
  assert.equal(byCode['6-01-001-01-00-00'].variance, 10000);
  assert.equal(byCode['6-01-001-01-00-00'].favorable, false);
  // internet: budgeted 12k, no actual → variance −12k, favorable (under budget)
  assert.equal(byCode['6-02-007-01-03-00'].actual, 0);
  assert.equal(byCode['6-02-007-01-03-00'].variance, -12000);
  assert.equal(byCode['6-02-007-01-03-00'].favorable, true);
});

test('net budget vs net actual', () => {
  const r = resolveBudgetVariance({ accounts, lines, entries, budgets, year: Y });
  // budget: 100k income − 0 cost − 92k expense = 8k; actual: 120k − 0 − 90k = 30k
  assert.equal(r.netBudget, 8000);
  assert.equal(r.netActual, 30000);
  assert.equal(r.netVariance, 22000);
});

test('movement outside the year is excluded', () => {
  const r = resolveBudgetVariance({ accounts, lines, entries: [{ id: 'e1', postedAt: Date.UTC(2025, 3, 15) }], budgets, year: Y });
  const sales = r.sections.flatMap((s) => s.rows).find((x) => x.code === '4-01-001-01-00-00');
  assert.equal(sales.actual, 0); // prior-year movement doesn't count
});
