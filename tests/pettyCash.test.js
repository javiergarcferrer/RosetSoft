/**
 * Caja chica (petty cash) — fund balance math + the balanced asiento each
 * voucher type posts (src/lib/accounting/pettyCash.ts), the funds overview /
 * ledger ViewModels (src/core/accounting/cajaChica.js), and the DGII 606
 * inclusion of NCF-backed vales. Money + the balance invariant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';
import {
  pettyCashBalance, voucherCashDelta, buildPettyCashEntry, VOUCHER_TYPE_LABEL,
} from '../src/lib/accounting/pettyCash.js';
import { resolveCajaChica, resolveFundLedger } from '../src/core/accounting/cajaChica.js';
import { resolve606 } from '../src/core/accounting/expenses.js';

const config = resolveAccountingConfig(null);
function ids() { let n = 0; return () => `id${++n}`; }
const FUND = { id: 'f1', profileId: 'team', name: 'Caja chica admin', accountCode: '1-01-001-01-02-00', fixedAmount: 10000, status: 'open', openedAt: 0 };

test('voucherCashDelta signs cash by type/direction', () => {
  assert.equal(voucherCashDelta({ type: 'opening', total: 10000 }), 10000);
  assert.equal(voucherCashDelta({ type: 'replenishment', total: 4000 }), 4000);
  assert.equal(voucherCashDelta({ type: 'expense', total: 1180 }), -1180);
  assert.equal(voucherCashDelta({ type: 'adjustment', total: 50, direction: 'over' }), 50);
  assert.equal(voucherCashDelta({ type: 'adjustment', total: 50, direction: 'short' }), -50);
});

test('pettyCashBalance nets a fund from its vouchers', () => {
  const vs = [
    { fundId: 'f1', type: 'opening', total: 10000 },
    { fundId: 'f1', type: 'expense', total: 1180 },
    { fundId: 'f1', type: 'expense', total: 500 },
    { fundId: 'f2', type: 'opening', total: 3000 }, // other fund — excluded by id
  ];
  assert.equal(pettyCashBalance(vs, 'f1'), 8320);
  assert.equal(pettyCashBalance(vs), 11320); // all funds
});

test('opening posts a balanced asiento (bank → caja chica)', () => {
  const { entry, lines } = buildPettyCashEntry({
    newId: ids(), config, fund: FUND,
    voucher: { id: 'v1', profileId: 'team', fundId: 'f1', type: 'opening', voucherAt: 0, base: 10000, itbis: 0, total: 10000, paymentMethod: 'bank' },
  });
  assert.equal(entry.refTable, 'petty_cash_vouchers');
  assert.equal(entry.source, 'opening');
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === FUND.accountCode).debit, 10000);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.bank).credit, 10000);
});

test('expense vale with creditable ITBIS splits the debit and credits the fund', () => {
  const { entry, lines } = buildPettyCashEntry({
    newId: ids(), config, fund: FUND,
    voucher: { id: 'v2', profileId: 'team', fundId: 'f1', type: 'expense', voucherAt: 0, accountCode: '6-02-007-01-03-00', ncf: 'B0100000123', base: 1000, itbis: 180, itbisCreditable: true, total: 1180 },
  });
  assert.equal(entry.source, 'expense');
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === '6-02-007-01-03-00').debit, 1000);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.itbisCredit).debit, 180);
  assert.equal(lines.find((l) => l.accountCode === FUND.accountCode).credit, 1180);
});

test('expense vale with non-creditable ITBIS expenses the whole amount', () => {
  const { lines } = buildPettyCashEntry({
    newId: ids(), config, fund: FUND,
    voucher: { id: 'v3', profileId: 'team', fundId: 'f1', type: 'expense', voucherAt: 0, accountCode: '6-02-001-00-00-00', base: 1000, itbis: 180, itbisCreditable: false, total: 1180 },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(debitTotal(lines), 1180);
  assert.equal(lines.find((l) => l.accountCode === '6-02-001-00-00-00').debit, 1180);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.itbisCredit), undefined);
});

test('arqueo: faltante expenses the difference, sobrante adds to income', () => {
  const short = buildPettyCashEntry({
    newId: ids(), config, fund: FUND,
    voucher: { id: 'v4', profileId: 'team', fundId: 'f1', type: 'adjustment', direction: 'short', voucherAt: 0, accountCode: '6-08-009-00-00-00', base: 0, itbis: 0, total: 75 },
  });
  assert.equal(debitTotal(short.lines), creditTotal(short.lines));
  assert.equal(short.lines.find((l) => l.accountCode === '6-08-009-00-00-00').debit, 75);
  assert.equal(short.lines.find((l) => l.accountCode === FUND.accountCode).credit, 75);
  const over = buildPettyCashEntry({
    newId: ids(), config, fund: FUND,
    voucher: { id: 'v5', profileId: 'team', fundId: 'f1', type: 'adjustment', direction: 'over', voucherAt: 0, accountCode: '4-03-009-00-00-00', base: 0, itbis: 0, total: 30 },
  });
  assert.equal(over.lines.find((l) => l.accountCode === FUND.accountCode).debit, 30);
  assert.equal(over.lines.find((l) => l.accountCode === '4-03-009-00-00-00').credit, 30);
});

test('expense vale needs a gasto account', () => {
  assert.throws(() => buildPettyCashEntry({
    newId: ids(), config, fund: FUND,
    voucher: { id: 'v6', profileId: 'team', fundId: 'f1', type: 'expense', voucherAt: 0, base: 100, itbis: 0, total: 100 },
  }), /cuenta de gasto/);
});

test('resolveCajaChica rolls up balance, headroom, low-cash flag', () => {
  const vouchers = [
    { id: 'a', fundId: 'f1', type: 'opening', voucherAt: 1, total: 10000 },
    { id: 'b', fundId: 'f1', type: 'expense', voucherAt: 2, total: 9000 },
  ];
  const r = resolveCajaChica({ funds: [FUND], vouchers });
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].balance, 1000);
  assert.equal(r.rows[0].fixedAmount, 10000);
  assert.equal(r.rows[0].toReplenish, 9000);
  assert.equal(r.rows[0].spent, 9000);
  assert.equal(r.rows[0].lowOnCash, true); // 1000 < 20% of 10000 (= 2000)
  assert.equal(r.totals.balance, 1000);
});

test('resolveFundLedger shows movements with a running balance, newest first', () => {
  const vouchers = [
    { id: 'a', fundId: 'f1', type: 'opening', voucherAt: 1, total: 10000 },
    { id: 'b', fundId: 'f1', type: 'expense', voucherAt: 2, total: 1180 },
  ];
  const r = resolveFundLedger({ fund: FUND, vouchers });
  assert.equal(r.balance, 8820);
  assert.equal(r.rows[0].voucher.id, 'b'); // newest first
  assert.equal(r.rows[0].balance, 8820);
  assert.equal(r.rows[0].label, VOUCHER_TYPE_LABEL.expense);
});

test('resolve606 folds in petty-cash vales that carry an NCF', () => {
  const suppliers = [{ id: 's1', name: 'Ferretería', rnc: '131000000', kind: 'juridica' }];
  const pettyCashVouchers = [
    { id: 'v1', fundId: 'f1', type: 'expense', voucherAt: 1000, accountCode: '6-02-008-00-00-00', supplierId: 's1', ncf: 'B0100000777', base: 1000, itbis: 180, total: 1180 },
    { id: 'v2', fundId: 'f1', type: 'expense', voucherAt: 1000, accountCode: '6-02-008-00-00-00', base: 200, itbis: 0, total: 200 }, // no NCF → excluded
    { id: 'v3', fundId: 'f1', type: 'opening', voucherAt: 1000, base: 5000, itbis: 0, total: 5000 }, // not an expense → excluded
  ];
  const r = resolve606({ pettyCashVouchers, suppliers });
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].ncf, 'B0100000777');
  assert.equal(r.rows[0].rnc, '131000000');
  assert.equal(r.rows[0].base, 1000);
  assert.equal(r.rows[0].itbis, 180);
  assert.equal(r.rows[0].pay, 'cash'); // petty cash is always cash-paid
});
