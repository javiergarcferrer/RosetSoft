/**
 * Depósitos por confirmar — the reconciliation between a quote's deposit SIGNAL
 * (the `deposito recibido` milestone) and the actual cobro in the books. This
 * pins the single flow from quoting to accounting: the quote never posts the
 * deposit; accounting confirms it with a cobro carrying the quote's id, and a
 * quote drops off the queue once it's confirmed OR invoiced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDepositConfirmations } from '../src/core/accounting/deposits.js';

const customersById = new Map([['c1', { id: 'c1', name: 'Ana' }]]);
const totalsByQuote = new Map([['qa', 1000], ['qb', 2000], ['qc', 3000], ['qd', 4000]]);

const quotes = [
  // signalled, not invoiced, not confirmed → IN the queue
  { id: 'qa', status: 'accepted', customerId: 'c1', depositReceivedAt: 200 },
  // signalled but already has a confirming cobro → OUT
  { id: 'qb', status: 'accepted', customerId: 'c1', depositReceivedAt: 100 },
  // signalled but already invoiced → OUT (folds into receivables)
  { id: 'qc', status: 'accepted', customerId: 'c1', depositReceivedAt: 150 },
  // accepted but NO deposit signal → OUT
  { id: 'qd', status: 'accepted', customerId: 'c1', depositReceivedAt: null },
  // deposit-ish field but not accepted → OUT
  { id: 'qe', status: 'sent', customerId: 'c1', depositReceivedAt: 50 },
];

const payments = [
  { id: 'p1', direction: 'in', partyType: 'customer', partyId: 'c1', quoteId: 'qb', amount: 500 },
  // a regular cobro (no quoteId) must NOT confirm anything
  { id: 'p2', direction: 'in', partyType: 'customer', partyId: 'c1', quoteId: null, amount: 99 },
];
const salesPostings = [
  { id: 's1', quoteId: 'qc', total: 3540, voidedAt: null },
];

test('resolveDepositConfirmations: only signalled, un-confirmed, un-invoiced quotes', () => {
  const { rows, count } = resolveDepositConfirmations({
    quotes, payments, salesPostings, totalsByQuote, customersById,
  });
  assert.equal(count, 1);
  assert.deepEqual(rows.map((r) => r.quoteId), ['qa']);
  assert.equal(rows[0].customer.name, 'Ana');
  assert.equal(rows[0].usdTotal, 1000);
  assert.equal(rows[0].signalledAt, 200);
});

test('resolveDepositConfirmations: a confirming cobro drops the quote off', () => {
  const q = [{ id: 'qa', status: 'accepted', customerId: 'c1', depositReceivedAt: 200 }];
  const before = resolveDepositConfirmations({ quotes: q, payments: [], salesPostings: [] });
  assert.equal(before.count, 1);
  const after = resolveDepositConfirmations({
    quotes: q,
    payments: [{ direction: 'in', quoteId: 'qa', amount: 500 }],
    salesPostings: [],
  });
  assert.equal(after.count, 0);
});

test('resolveDepositConfirmations: a voided factura does NOT count as invoiced', () => {
  const q = [{ id: 'qa', status: 'accepted', customerId: 'c1', depositReceivedAt: 200 }];
  const { count } = resolveDepositConfirmations({
    quotes: q, payments: [], salesPostings: [{ quoteId: 'qa', voidedAt: 123 }],
  });
  assert.equal(count, 1);
});

test('resolveDepositConfirmations: oldest signal first', () => {
  const q = [
    { id: 'a', status: 'accepted', depositReceivedAt: 300 },
    { id: 'b', status: 'accepted', depositReceivedAt: 100 },
    { id: 'c', status: 'accepted', depositReceivedAt: 200 },
  ];
  const { rows } = resolveDepositConfirmations({ quotes: q, payments: [], salesPostings: [] });
  assert.deepEqual(rows.map((r) => r.quoteId), ['b', 'c', 'a']);
});

test('resolveDepositConfirmations: empty/missing inputs → empty queue', () => {
  assert.deepEqual(resolveDepositConfirmations(), { rows: [], count: 0 });
  assert.deepEqual(resolveDepositConfirmations({ quotes: [] }), { rows: [], count: 0 });
});
