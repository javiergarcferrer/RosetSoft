/**
 * Tests for the money-movement loop — payment asientos with gateway deductions
 * (src/lib/accounting/payment.ts) and the CxC/CxP aging + statement
 * (src/core/accounting/receivables.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { buildPaymentEntry, paymentNet } from '../src/lib/accounting/payment.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';
import { resolveReceivables, resolvePayables, resolvePartyStatement, resolveStatementFor } from '../src/core/accounting/receivables.js';

const config = resolveAccountingConfig(null);
const M = config.postingMap;
function ids() { let n = 0; return () => `id${++n}`; }
const DAY = 86_400_000;

/* ------------------------------ payments -------------------------------- */

test('cobro en efectivo: Debit caja / Credit CxC, balanced', () => {
  const { lines } = buildPaymentEntry({
    newId: ids(), config,
    payment: { id: 'p1', direction: 'in', partyType: 'customer', partyId: 'c1', amount: 5000, method: 'cash' },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.cash).debit, 5000);
  assert.equal(lines.find((l) => l.accountCode === M.accountsReceivable).credit, 5000);
});

test('cobro por tarjeta: gateway commission + retentions, bank gets the net', () => {
  const { lines } = buildPaymentEntry({
    newId: ids(), config,
    payment: {
      id: 'p2', direction: 'in', partyType: 'customer', partyId: 'c1', amount: 11800, method: 'card',
      commission: 300, commissionItbis: 54, itbisRetained: 540, isrRetained: 100,
    },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  // Credit CxC at the gross.
  assert.equal(lines.find((l) => l.accountCode === M.accountsReceivable).credit, 11800);
  // Bank gets gross − all deductions.
  assert.equal(paymentNet({ amount: 11800, commission: 300, commissionItbis: 54, itbisRetained: 540, isrRetained: 100 }), 10806);
  assert.equal(lines.find((l) => l.accountCode === M.bank).debit, 10806);
  assert.equal(lines.find((l) => l.accountCode === M.cardCommissions).debit, 300);
  // commItbis + retITBIS both creditable → one ITBIS-adelantado line.
  assert.equal(lines.find((l) => l.accountCode === M.itbisCredit).debit, 594);
  assert.equal(lines.find((l) => l.accountCode === M.isrAdvance).debit, 100);
});

test('pago a suplidor: Debit CxP / Credit banco', () => {
  const { lines } = buildPaymentEntry({
    newId: ids(), config,
    payment: { id: 'p3', direction: 'out', partyType: 'supplier', partyId: 's1', amount: 8000, method: 'bank' },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.accountsPayable).debit, 8000);
  assert.equal(lines.find((l) => l.accountCode === M.bank).credit, 8000);
});

test('buildPaymentEntry rejects a non-positive amount', () => {
  assert.throws(() => buildPaymentEntry({
    newId: ids(), config, payment: { id: 'p4', direction: 'in', partyType: 'customer', amount: 0, method: 'cash' },
  }), /mayor que cero/);
});

/* --------------------------- receivables -------------------------------- */

test('resolveReceivables: balance + FIFO aging per customer', () => {
  const now = 100 * DAY;
  const customersById = new Map([['c1', { id: 'c1', name: 'Cliente A' }]]);
  const salesPostings = [
    { customerId: 'c1', postedAt: 100 * DAY - 80 * DAY, total: 10000, depositApplied: 0 }, // 80 days old
    { customerId: 'c1', postedAt: 100 * DAY - 10 * DAY, total: 5000, depositApplied: 0 },   // 10 days old
  ];
  const payments = [{ direction: 'in', partyType: 'customer', partyId: 'c1', paidAt: 100 * DAY, amount: 4000 }];
  const r = resolveReceivables({ salesPostings, payments, customersById, asOf: now });
  assert.equal(r.count, 1);
  const row = r.rows[0];
  assert.equal(row.invoiced, 15000);
  assert.equal(row.paid, 4000);
  assert.equal(row.balance, 11000);
  // 4000 applied to the oldest (10000→6000 open, 61-90 bucket); newest 5000 in 0-30.
  assert.equal(row.buckets.d61_90, 6000);
  assert.equal(row.buckets.d0_30, 5000);
});

test('resolveReceivables honors explicit allocations, FIFO for the rest', () => {
  const now = 100 * DAY;
  const customersById = new Map([['c1', { id: 'c1', name: 'A' }]]);
  const salesPostings = [
    { id: 'a', customerId: 'c1', postedAt: 100 * DAY - 80 * DAY, total: 10000, depositApplied: 0 }, // old
    { id: 'b', customerId: 'c1', postedAt: 100 * DAY - 10 * DAY, total: 5000, depositApplied: 0 },   // new
  ];
  // 4000 explicitly applied to the NEWER invoice b → b open 1000 (0-30), a fully open (61-90).
  const payments = [{ direction: 'in', partyType: 'customer', partyId: 'c1', paidAt: 100 * DAY, amount: 4000, allocations: [{ docId: 'b', amount: 4000 }] }];
  const r = resolveReceivables({ salesPostings, payments, customersById, asOf: now });
  const row = r.rows[0];
  assert.equal(row.buckets.d0_30, 1000);
  assert.equal(row.buckets.d61_90, 10000);
  assert.equal(row.balance, 11000);
  assert.equal(row.docs.find((d) => d.docId === 'b').open, 1000);
});

test('resolvePayables: only credit docs, balance per supplier', () => {
  const suppliersById = new Map([['s1', { id: 's1', name: 'LR' }]]);
  const purchases = [{ supplierId: 's1', purchaseAt: 1, paymentMethod: 'credit', base: 50000, itbis: 9000, retentionIsr: 0, retentionItbis: 0 }];
  const expenses = [{ supplierId: 's1', expenseAt: 2, paymentMethod: 'bank', base: 1000, itbis: 180, retentionIsr: 0, retentionItbis: 0 }]; // not credit → excluded
  const payments = [{ direction: 'out', partyType: 'supplier', partyId: 's1', paidAt: 3, amount: 20000 }];
  const r = resolvePayables({ purchases, expenses, payments, suppliersById, asOf: 10 });
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].invoiced, 59000);
  assert.equal(r.rows[0].balance, 39000);
});

test('resolvePartyStatement: chronological running balance', () => {
  const st = resolvePartyStatement({
    charges: [{ date: 1, amount: 10000, label: 'Factura' }, { date: 3, amount: 5000, label: 'Factura' }],
    payments: [{ date: 2, amount: 4000, label: 'Cobro' }],
  });
  assert.deepEqual(st.rows.map((r) => r.balance), [10000, 6000, 11000]);
  assert.equal(st.balance, 11000);
});

test('resolveStatementFor: customer charges net of deposit; supplier credit docs net of retenciones', () => {
  const customersById = new Map([['c1', { name: 'Ana' }]]);
  const suppliersById = new Map([['s1', { name: 'Proveedor SA' }]]);
  const salesPostings = [
    { customerId: 'c1', postedAt: 1, total: 11800, depositApplied: 1800, ncf: 'B01' },
    { customerId: 'c1', postedAt: 2, total: 1000, depositApplied: 1000 }, // fully covered → no charge row
    { customerId: 'other', postedAt: 3, total: 99 },
  ];
  const payments = [
    { direction: 'in', partyId: 'c1', paidAt: 4, amount: 4000, reference: 'TRX1' },
    { direction: 'out', partyId: 's1', paidAt: 5, amount: 500 },
  ];
  const cust = resolveStatementFor({ selected: { type: 'customer', id: 'c1' }, salesPostings, payments, customersById, suppliersById });
  assert.equal(cust.name, 'Ana');
  assert.deepEqual(cust.rows.map((r) => [r.label, r.charge, r.payment]), [['Factura', 10000, 0], ['Cobro', 0, 4000]]);
  assert.equal(cust.balance, 6000);

  const purchases = [{ supplierId: 's1', paymentMethod: 'credit', purchaseAt: 1, base: 1000, itbis: 180, ncf: 'B11' }];
  const expenses = [{ supplierId: 's1', paymentMethod: 'credit', expenseAt: 2, base: 500, itbis: 90, retentionIsr: 50, retentionItbis: 27 }];
  const sup = resolveStatementFor({ selected: { type: 'supplier', id: 's1' }, salesPostings, payments, purchases, expenses, customersById, suppliersById });
  assert.equal(sup.name, 'Proveedor SA');
  assert.deepEqual(sup.rows.map((r) => [r.label, r.charge, r.payment]), [['Compra', 1180, 0], ['Gasto', 513, 0], ['Pago', 0, 500]]);
  assert.equal(sup.balance, 1193);
  assert.equal(resolveStatementFor({ selected: null }), null);
});
