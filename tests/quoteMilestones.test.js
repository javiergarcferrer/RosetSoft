/**
 * Tests for src/lib/quoteMilestones.js and the container-fill gate
 * in src/lib/orderStages.js.
 *
 * The user's domain rules, as stated:
 *   • "El acto de confirmar la cotización es recibir el depósito" —
 *     deposit can be marked once the quote is accepted.
 *   • "El balance se debe marcar antes de entregar" — balance comes
 *     after deposit, delivery after balance + order received.
 *   • "Los contenedores… solo se marca si están llenos" — container
 *     fill is the gate on the order's 'received' transition.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canMarkDeposit, canMarkBalance, canMarkDelivered,
  deliveryBlockedReason, quoteMilestoneState, quoteOutstanding,
} from '../src/lib/quoteMilestones.js';
import {
  canAdvanceOrder, nextOrderStage, advanceBlockedReason,
} from '../src/lib/orderStages.js';

/* ------------------------------- deposit ------------------------------- */

test('deposit can be marked on an accepted quote with no deposit yet', () => {
  const quote = { status: 'accepted' };
  assert.equal(canMarkDeposit(quote), true);
});

test('deposit cannot be marked on a draft / sent / declined quote', () => {
  for (const status of ['draft', 'sent', 'declined', 'archived']) {
    assert.equal(canMarkDeposit({ status }), false, `status=${status}`);
  }
});

test('deposit cannot be re-marked once recorded', () => {
  const quote = { status: 'accepted', depositReceivedAt: 1 };
  assert.equal(canMarkDeposit(quote), false);
});

/* ------------------------------- balance ------------------------------- */

test('balance requires a deposit on record', () => {
  assert.equal(canMarkBalance({ status: 'accepted' }), false);
  assert.equal(canMarkBalance({ status: 'accepted', depositReceivedAt: 1 }), true);
});

test('balance cannot be re-marked', () => {
  const quote = { depositReceivedAt: 1, balancePaidAt: 2 };
  assert.equal(canMarkBalance(quote), false);
});

/* ------------------------------ delivery ------------------------------- */

test('delivery requires balance paid AND parent order in received', () => {
  const happy = {
    quote:  { depositReceivedAt: 1, balancePaidAt: 2 },
    order:  { status: 'received' },
  };
  assert.equal(canMarkDelivered(happy.quote, happy.order), true);
});

test('delivery is blocked when balance missing — even if order is received', () => {
  const quote = { depositReceivedAt: 1 };          // balance missing
  const order = { status: 'received' };
  assert.equal(canMarkDelivered(quote, order), false);
});

test('delivery is blocked when order is still in transit — even with balance paid', () => {
  const quote = { depositReceivedAt: 1, balancePaidAt: 2 };
  const order = { status: 'in_transit' };
  assert.equal(canMarkDelivered(quote, order), false);
});

test('delivery cannot be re-marked', () => {
  const quote = { depositReceivedAt: 1, balancePaidAt: 2, deliveredAt: 3 };
  const order = { status: 'received' };
  assert.equal(canMarkDelivered(quote, order), false);
});

/* ------------------------ deliveryBlockedReason ----------------------- */

test('deliveryBlockedReason returns the right hint for each missing step', () => {
  // Missing deposit
  assert.match(
    deliveryBlockedReason({}, { status: 'received' }),
    /dep[oó]sito/i,
  );
  // Missing balance
  assert.match(
    deliveryBlockedReason({ depositReceivedAt: 1 }, { status: 'received' }),
    /balance/i,
  );
  // Order not received
  assert.match(
    deliveryBlockedReason(
      { depositReceivedAt: 1, balancePaidAt: 2 },
      { status: 'in_customs' },
    ),
    /Recibido/i,
  );
  // Everything aligned → no hint
  assert.equal(
    deliveryBlockedReason(
      { depositReceivedAt: 1, balancePaidAt: 2 },
      { status: 'received' },
    ),
    null,
  );
});

/* ------------------------ quoteMilestoneState ------------------------- */

test('quoteMilestoneState is a boolean snapshot of the three flags', () => {
  assert.deepEqual(
    quoteMilestoneState({ depositReceivedAt: 1, balancePaidAt: null, deliveredAt: null }),
    { deposit: true, balance: false, delivered: false },
  );
  assert.deepEqual(
    quoteMilestoneState(null),
    { deposit: false, balance: false, delivered: false },
  );
});

/* ------------------------ order advance gate -------------------------- */

test('order advance from in_customs → received requires all containers filled', () => {
  const order = { status: 'in_customs' };
  // No containers
  assert.equal(canAdvanceOrder(order, []), false);
  // Some unfilled
  assert.equal(
    canAdvanceOrder(order, [{ filledAt: 1 }, { filledAt: null }]),
    false,
  );
  // All filled
  assert.equal(
    canAdvanceOrder(order, [{ filledAt: 1 }, { filledAt: 2 }]),
    true,
  );
});

test('order advance from draft → placed requires the dispatch threshold to be met', () => {
  const order = { status: 'draft' };
  // Below threshold
  assert.equal(
    canAdvanceOrder(order, [], { totalAmount: 30000, threshold: 50000 }),
    false,
  );
  // At threshold
  assert.equal(
    canAdvanceOrder(order, [], { totalAmount: 50000, threshold: 50000 }),
    true,
  );
  // Above threshold
  assert.equal(
    canAdvanceOrder(order, [], { totalAmount: 60000, threshold: 50000 }),
    true,
  );
});

test('threshold of 0 (or missing opts) does not block placement', () => {
  // When the dealer hasn't configured a minimum, we don't gate — same
  // behavior as the legacy "no threshold" case.
  const order = { status: 'draft' };
  assert.equal(canAdvanceOrder(order, [], { totalAmount: 0, threshold: 0 }), true);
  assert.equal(canAdvanceOrder(order, []), true);
});

test('mid-lifecycle transitions are still not gated by anything', () => {
  // placed → confirmed → in_transit → in_customs all flow freely.
  for (const status of ['placed', 'confirmed', 'in_transit']) {
    assert.equal(
      canAdvanceOrder({ status }, [], { totalAmount: 0, threshold: 0 }),
      true,
      `status=${status} should advance freely`,
    );
  }
});

test('advanceBlockedReason explains the threshold gate with a shortfall amount', () => {
  const reason = advanceBlockedReason(
    { status: 'draft' }, [],
    { totalAmount: 30000, threshold: 50000 },
  );
  assert.match(reason, /m[ií]nimo de despacho/i);
  // The shortfall ($20,000) should appear in the message so the dealer
  // knows how much more to sell before placing.
  assert.match(reason, /20,000/);
});

test('advanceBlockedReason explains the container-fill gate', () => {
  const order = { status: 'in_customs' };
  assert.match(advanceBlockedReason(order, []), /a[ñn]ade.*contenedor/i);
  assert.match(
    advanceBlockedReason(order, [{ filledAt: null }]),
    /llenos/i,
  );
  assert.equal(advanceBlockedReason(order, [{ filledAt: 1 }]), null);
});

test('the new stage chain is draft → placed → confirmed → in_transit → in_customs → received', () => {
  // Spec verification: nextOrderStage walks the new six-stage chain.
  const chain = [];
  let s = 'draft';
  for (let i = 0; i < 6; i++) {
    chain.push(s);
    const next = nextOrderStage(s);
    if (!next) break;
    s = next.key;
  }
  assert.deepEqual(
    chain,
    ['draft', 'placed', 'confirmed', 'in_transit', 'in_customs', 'received'],
  );
});

/* ----------------------------- outstanding ----------------------------- */

test('quoteOutstanding: nothing paid → the full total is owed', () => {
  assert.equal(quoteOutstanding({ depositAmount: 4000 }, 10000), 10000);
});

test('quoteOutstanding: order in flight, deposit received → total minus the deposit', () => {
  const q = { orderId: 'o1', depositReceivedAt: 1, depositAmount: 4000 };
  assert.equal(quoteOutstanding(q, 10000), 6000);
});

test('quoteOutstanding: order in flight, deposit without an amount leaves the full total owed', () => {
  // Better to over-state what's owed than silently forgive the balance.
  const q = { orderId: 'o1', depositReceivedAt: 1, depositAmount: null };
  assert.equal(quoteOutstanding(q, 10000), 10000);
});

test('quoteOutstanding: floor sale (no order) + deposit → zero — the deposit is the full collection', () => {
  // A floor/stock sale has no balance cycle: once the deposit lands the piece
  // leaves the floor, so nothing is outstanding regardless of depositAmount.
  assert.equal(quoteOutstanding({ depositReceivedAt: 1, depositAmount: 4000 }, 10000), 0);
  assert.equal(quoteOutstanding({ depositReceivedAt: 1, depositAmount: null }, 10000), 0);
});

test('quoteOutstanding: balance paid → zero, delivered or not', () => {
  assert.equal(quoteOutstanding({ orderId: 'o1', depositReceivedAt: 1, balancePaidAt: 2, depositAmount: 4000 }, 10000), 0);
  assert.equal(quoteOutstanding({ orderId: 'o1', depositReceivedAt: 1, balancePaidAt: 2, deliveredAt: 3 }, 10000), 0);
});

test('quoteOutstanding: never negative (over-collected deposit on an order clamps to 0)', () => {
  const q = { orderId: 'o1', depositReceivedAt: 1, depositAmount: 12000 };
  assert.equal(quoteOutstanding(q, 10000), 0);
});
