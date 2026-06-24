/**
 * Tests for the line-by-line SALE posting Model (buildSalesBillEntry in
 * src/lib/accounting/sale.ts) — the credit-side mirror of buildBillEntry: each
 * revenue line credits its own ingreso account, ITBIS is summed to ITBIS por
 * pagar, and the debit lands on the receivable (credit terms) or cash/bank
 * (paid). Pins the asiento balanced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { buildSalesBillEntry } from '../src/lib/accounting/sale.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';

const config = resolveAccountingConfig(null);
const M = config.postingMap;
function ids() { let n = 0; return () => `id${++n}`; }

test('buildSalesBillEntry: multi-account revenue + ITBIS payable, credit terms, balanced', () => {
  const { lines } = buildSalesBillEntry({
    newId: ids(), config,
    sale: {
      id: 's1', customerId: 'c1', paymentMethod: 'credit', ncf: 'E310000000001',
      lines: [{ accountCode: '4-01', base: 5000, itbis: 900 }, { accountCode: '4-02', base: 2000, itbis: 360 }],
    },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.accountsReceivable).debit, 8260); // total to CxC
  assert.equal(lines.find((l) => l.accountCode === '4-01').credit, 5000);
  assert.equal(lines.find((l) => l.accountCode === '4-02').credit, 2000);
  assert.equal(lines.find((l) => l.accountCode === M.itbisPayable).credit, 1260);
});

test('buildSalesBillEntry: cash sale debits caja and merges same account', () => {
  const { lines } = buildSalesBillEntry({
    newId: ids(), config,
    sale: { id: 's2', paymentMethod: 'cash', lines: [{ accountCode: '4-01', base: 3000, itbis: 540 }, { accountCode: '4-01', base: 1000, itbis: 180 }] },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.cash).debit, 4720); // 4000 + 720
  assert.equal(lines.find((l) => l.accountCode === '4-01').credit, 4000); // merged
});

test('buildSalesBillEntry: a deposit clears the liability before the receivable', () => {
  const { lines } = buildSalesBillEntry({
    newId: ids(), config,
    sale: { id: 's3', customerId: 'c1', paymentMethod: 'credit', deposit: 2000, lines: [{ accountCode: '4-01', base: 5000, itbis: 900 }] },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.customerDeposits).debit, 2000);
  assert.equal(lines.find((l) => l.accountCode === M.accountsReceivable).debit, 3900); // 5900 − 2000
});

test('buildSalesBillEntry: a line without an account throws', () => {
  assert.throws(() => buildSalesBillEntry({
    newId: ids(), config, sale: { id: 's4', paymentMethod: 'cash', lines: [{ accountCode: '', base: 100, itbis: 0 }] },
  }), /cuenta/i);
});
