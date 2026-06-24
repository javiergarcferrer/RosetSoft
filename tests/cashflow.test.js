/**
 * Estado de flujo de efectivo — opening/closing cash, activity rollup, and the
 * cash-flow identity (operating + investing + financing = flujo neto).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { round2 } from '../src/lib/accounting/ledger.js';
import { resolveCashFlow } from '../src/core/accounting/cashflow.js';

const accounts = [
  { code: '1-01-001-02-00-00', isPostable: true, name: 'Banco', class: 1, nature: 'debit' },
  { code: '1-01-002-00-00-00', isPostable: true, name: 'CxC', class: 1, nature: 'debit' },
  { code: '4-01-001-01-00-00', isPostable: true, name: 'Ventas', class: 4, nature: 'credit' },
  { code: '6-01-001-01-00-00', isPostable: true, name: 'Salarios', class: 6, nature: 'debit' },
  { code: '3-01-001-00-00-00', isPostable: true, name: 'Capital', class: 3, nature: 'credit' },
];
const BANK = '1-01-001-02-00-00';
const T = (d) => Date.UTC(2026, 0, d);

const entries = [
  { id: 'e0', source: 'opening', postedAt: T(1) },
  { id: 'e1', source: 'payment', postedAt: T(5) },
  { id: 'e2', source: 'payroll', postedAt: T(10) },
  { id: 'e3', source: 'sale', postedAt: T(7) }, // credit sale — never touches cash
];
const lines = [
  { entryId: 'e0', accountCode: BANK, debit: 100000, credit: 0 },
  { entryId: 'e0', accountCode: '3-01-001-00-00-00', debit: 0, credit: 100000 },
  { entryId: 'e1', accountCode: BANK, debit: 50000, credit: 0 },
  { entryId: 'e1', accountCode: '1-01-002-00-00-00', debit: 0, credit: 50000 },
  { entryId: 'e2', accountCode: BANK, debit: 0, credit: 30000 },
  { entryId: 'e2', accountCode: '6-01-001-01-00-00', debit: 30000, credit: 0 },
  { entryId: 'e3', accountCode: '1-01-002-00-00-00', debit: 23600, credit: 0 },
  { entryId: 'e3', accountCode: '4-01-001-01-00-00', debit: 0, credit: 23600 },
];

test('windowed: opening before start, net within, closing after', () => {
  const cf = resolveCashFlow({ accounts, entries, lines, start: T(3), end: T(31) });
  assert.equal(cf.opening, 100000); // capital injection (Jan 1) precedes the window
  assert.equal(cf.netChange, 20000); // +50000 cobro − 30000 nómina
  assert.equal(cf.closing, 120000);
  const bySrc = Object.fromEntries(cf.rows.map((r) => [r.source, r.amount]));
  assert.equal(bySrc.payment, 50000);
  assert.equal(bySrc.payroll, -30000);
  assert.equal(bySrc.sale, undefined); // credit sale never moved cash
});

test('all-time (no start): opening 0, financing vs operating split', () => {
  const cf = resolveCashFlow({ accounts, entries, lines, end: T(31) });
  assert.equal(cf.opening, 0);
  assert.equal(cf.netChange, 120000);
  assert.equal(cf.closing, 120000);
  assert.equal(cf.financing, 100000); // opening source → financing
  assert.equal(cf.operating, 20000);
  assert.equal(cf.investing, 0);
});

test('cash-flow identity: operating + investing + financing = flujo neto', () => {
  const cf = resolveCashFlow({ accounts, entries, lines, end: T(31) });
  assert.equal(round2(cf.operating + cf.investing + cf.financing), cf.netChange);
});

test('no cash accounts → empty, balanced result', () => {
  const cf = resolveCashFlow({ accounts: [{ code: '4-01', isPostable: true, class: 4 }], entries, lines });
  assert.equal(cf.netChange, 0);
  assert.equal(cf.sections.length, 0);
});
