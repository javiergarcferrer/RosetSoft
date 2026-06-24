/**
 * Tests for the line-by-line bill posting Model (src/lib/accounting/bill.ts):
 * resolveBillLines (qty×price + per-line taxes + totals) and buildBillEntry
 * (one debit per distinct account, ITBIS credit, net payable, retentions —
 * balanced). Pins the reference Odoo bill (net 5 630).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { resolveBillLines, buildBillEntry } from '../src/lib/accounting/bill.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';

const config = resolveAccountingConfig(null);
const M = config.postingMap;
function ids() { let n = 0; return () => `id${++n}`; }

test('resolveBillLines: base = qty×price, per-line taxes, totals, blanks dropped', () => {
  const { lines, totals } = resolveBillLines([
    { id: 'a', description: 'Mantenimiento', accountCode: '61030206', qty: 1, unitPrice: 5000, taxIds: ['itbis18', 'retItbis30'] },
    { id: 'b', description: 'Materiales', accountCode: '6-02', qty: 2, unitPrice: 1000, taxIds: ['itbis18'] },
    { id: 'c' }, // blank → dropped
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].base, 5000);
  assert.equal(lines[0].itbis, 900);
  assert.equal(lines[0].retItbis, 270);
  assert.equal(lines[1].base, 2000);
  assert.equal(lines[1].itbis, 360);
  assert.deepEqual(totals, { base: 7000, itbis: 1260, retIsr: 0, retItbis: 270, total: 8260, net: 7990 });
});

test('buildBillEntry: the reference single-line bill posts balanced (net 5 630)', () => {
  const { lines } = buildBillEntry({
    newId: ids(), config,
    bill: {
      id: 'p1', supplierId: 's1', paymentMethod: 'credit', ncf: 'E310000006621',
      lines: [{ accountCode: '61030206', base: 5000, itbis: 900, retIsr: 0, retItbis: 270 }],
    },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === '61030206').debit, 5000);
  assert.equal(lines.find((l) => l.accountCode === M.itbisCredit).debit, 900);
  assert.equal(lines.find((l) => l.accountCode === M.accountsPayable).credit, 5630); // net to suplidores
  assert.equal(lines.find((l) => l.accountCode === M.itbisWithheld).credit, 270);
});

test('buildBillEntry: two lines → one debit per distinct account (merged), balanced', () => {
  const { lines } = buildBillEntry({
    newId: ids(), config,
    bill: {
      id: 'p2', supplierId: 's1', paymentMethod: 'bank',
      lines: [
        { accountCode: 'A', base: 3000, itbis: 540, retIsr: 0, retItbis: 0 },
        { accountCode: 'B', base: 1000, itbis: 180, retIsr: 0, retItbis: 0 },
        { accountCode: 'A', base: 2000, itbis: 360, retIsr: 0, retItbis: 0 }, // same A → merged
      ],
    },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === 'A').debit, 5000); // 3000 + 2000
  assert.equal(lines.find((l) => l.accountCode === 'B').debit, 1000);
  assert.equal(lines.find((l) => l.accountCode === M.itbisCredit).debit, 1080);
  assert.equal(lines.find((l) => l.accountCode === M.bank).credit, 7080); // 6000 + 1080
});

test('buildBillEntry: ISR + ITBIS retentions both credited; net reduced', () => {
  const { lines } = buildBillEntry({
    newId: ids(), config,
    bill: { id: 'p3', paymentMethod: 'bank', lines: [{ accountCode: 'X', base: 5000, itbis: 900, retIsr: 500, retItbis: 270 }] },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.isrWithheld).credit, 500);
  assert.equal(lines.find((l) => l.accountCode === M.itbisWithheld).credit, 270);
  assert.equal(lines.find((l) => l.accountCode === M.bank).credit, 5130); // 5000 + 900 − 500 − 270
});

test('buildBillEntry: a line without an account throws', () => {
  assert.throws(() => buildBillEntry({
    newId: ids(), config,
    bill: { id: 'p4', paymentMethod: 'bank', lines: [{ accountCode: '', base: 100, itbis: 0, retIsr: 0, retItbis: 0 }] },
  }), /cuenta/i);
});
