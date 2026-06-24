/**
 * Cuentas por cobrar — open balance, FIFO aging, and the per-party estado de
 * cuenta. Pins that a nota de crédito (E34) REDUCES the customer receivable
 * (never inflates it), that an allocation to a foreign doc is ignored rather
 * than silently consumed, and that the printed statement nets credit notes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReceivables, resolveStatementFor } from '../src/core/accounting/receivables.js';

const T = (d) => Date.UTC(2026, 0, d);
const cust = (id) => ({ direction: 'in', partyType: 'customer', partyId: id });

test('a nota de crédito nets down the receivable instead of adding a charge', () => {
  const salesPostings = [
    { id: 's1', customerId: 'c1', postedAt: T(1), ncf: 'E310000000001', total: 11800 },
    { id: 's2', customerId: 'c1', postedAt: T(5), ncf: 'E340000000001', total: 4720 }, // nota de crédito
  ];
  const r = resolveReceivables({ salesPostings, payments: [], customersById: new Map(), asOf: T(6) });
  const row = r.rows.find((x) => x.partyId === 'c1');
  assert.equal(row.invoiced, 11800);
  assert.equal(row.credited, 4720);
  assert.equal(row.balance, 7080); // 11800 − 4720, NOT 16520
  assert.equal(row.buckets.d0_30, 7080); // the credit offset the open invoice in aging too
});

test('a nota de crédito on a fully-paid sale yields a negative (refund-owed) balance', () => {
  const salesPostings = [
    { id: 's1', customerId: 'c1', postedAt: T(1), ncf: 'E310000000001', total: 11800 },
    { id: 's2', customerId: 'c1', postedAt: T(5), ncf: 'E340000000001', total: 4720 },
  ];
  const payments = [{ ...cust('c1'), paidAt: T(3), amount: 11800, allocations: [] }];
  const r = resolveReceivables({ salesPostings, payments, customersById: new Map() });
  const row = r.rows.find((x) => x.partyId === 'c1');
  assert.equal(row.balance, -4720); // the dealer now owes the customer
});

test('an allocation naming a foreign doc is ignored, not silently consumed', () => {
  const salesPostings = [{ id: 's1', customerId: 'c1', postedAt: T(1), ncf: 'E31', total: 5000 }];
  const payments = [{ ...cust('c1'), paidAt: T(2), amount: 5000, allocations: [{ docId: 'FOREIGN', amount: 5000 }] }];
  const r = resolveReceivables({ salesPostings, payments, customersById: new Map() });
  // The 5000 must still settle s1 via the FIFO remainder → balance 0 → row dropped.
  assert.equal(r.rows.length, 0);
});

test('estado de cuenta shows the nota de crédito as an abono reducing the running balance', () => {
  const salesPostings = [
    { id: 's1', customerId: 'c1', postedAt: T(1), ncf: 'E31', total: 11800 },
    { id: 's2', customerId: 'c1', postedAt: T(5), ncf: 'E34', total: 4720 },
  ];
  const st = resolveStatementFor({ selected: { type: 'customer', id: 'c1' }, salesPostings, payments: [], customersById: new Map() });
  assert.equal(st.balance, 7080);
  const note = st.rows.find((r) => r.label === 'Nota de crédito');
  assert.ok(note, 'the statement lists a Nota de crédito row');
  assert.equal(note.payment, 4720); // in the abono column, not as a second charge
  assert.equal(note.charge, 0);
});

test('plain invoices with a partial payment still age correctly (no regression)', () => {
  const salesPostings = [
    { id: 's1', customerId: 'c1', postedAt: T(1), ncf: 'E31', total: 5000 },
    { id: 's2', customerId: 'c1', postedAt: T(2), ncf: 'E31', total: 3000 },
  ];
  const payments = [{ ...cust('c1'), paidAt: T(3), amount: 5000, allocations: [] }];
  const r = resolveReceivables({ salesPostings, payments, customersById: new Map() });
  const row = r.rows.find((x) => x.partyId === 'c1');
  assert.equal(row.invoiced, 8000);
  assert.equal(row.paid, 5000);
  assert.equal(row.balance, 3000); // FIFO cleared s1, s2 still open
});
