import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lsgSaleAdjustments, lsgDesiredUnits, lsgCommitmentDeltas, quoteHoldsLsgStock,
} from '../src/lib/lsgSale.js';

// reference (SKU) → LSG product id (lsg-<variantId>)
const byRef = new Map([
  ['LSG-AAA', 'lsg-111'],
  ['LSG-BBB', 'lsg-222'],
  ['LSG-CCC', 'lsg-333'],
]);

test('a priced simple LSG line decrements by its quantity (negative delta)', () => {
  const adj = lsgSaleAdjustments([{ kind: 'item', reference: 'LSG-AAA', qty: 2 }], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -2 }]);
});

test('Ligne Roset / free-typed references (absent from the map) are ignored', () => {
  const adj = lsgSaleAdjustments([
    { kind: 'item', reference: 'LR-SOFA', qty: 1 },
    { kind: 'item', reference: 'LSG-AAA', qty: 1 },
  ], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -1 }]);
});

test('optional, non-selected-alternative, and section lines never decrement', () => {
  const adj = lsgSaleAdjustments([
    { kind: 'item', reference: 'LSG-AAA', qty: 1, isOptional: true },
    { kind: 'item', reference: 'LSG-BBB', qty: 1, alternativeGroup: 'g1', isSelectedAlternative: false },
    { kind: 'section', reference: 'LSG-CCC', qty: 1 },
  ], byRef);
  assert.deepEqual(adj, []);
});

test('the selected alternative IS counted', () => {
  const adj = lsgSaleAdjustments([
    { kind: 'item', reference: 'LSG-AAA', qty: 1, alternativeGroup: 'g1', isSelectedAlternative: true },
    { kind: 'item', reference: 'LSG-BBB', qty: 1, alternativeGroup: 'g1', isSelectedAlternative: false },
  ], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -1 }]);
});

test('compound: priced components count (folding line qty); optional ones do not', () => {
  const adj = lsgSaleAdjustments([{
    kind: 'item', reference: 'LSG-AAA', qty: 2,
    components: [
      { reference: 'LSG-BBB', qty: 1 },                 // priced → 2*1
      { reference: 'LSG-CCC', qty: 3, isOptional: true }, // optional → skip
    ],
  }], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-222', delta: -2 }]);
});

test('the same variant across lines/components is summed once', () => {
  const adj = lsgSaleAdjustments([
    { kind: 'item', reference: 'LSG-AAA', qty: 1 },
    { kind: 'item', reference: 'LSG-AAA', qty: 2 },
  ], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -3 }]);
});

test('accepts a plain object map as well as a Map', () => {
  const adj = lsgSaleAdjustments(
    [{ kind: 'item', reference: 'LSG-AAA', qty: 1 }],
    { 'LSG-AAA': 'lsg-111' },
  );
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -1 }]);
});

test('empty / missing inputs yield no adjustments', () => {
  assert.deepEqual(lsgSaleAdjustments([], byRef), []);
  assert.deepEqual(lsgSaleAdjustments(null, byRef), []);
});

// ── lsgDesiredUnits: the positive units map behind both the one-shot
// decrement and the reconciler. Same gating as lsgSaleAdjustments. ──────────
test('lsgDesiredUnits returns positive units per LSG product id', () => {
  const units = lsgDesiredUnits([
    { kind: 'item', reference: 'LSG-AAA', qty: 2 },
    { kind: 'item', reference: 'LSG-AAA', qty: 1 },
    { kind: 'item', reference: 'LR-SOFA', qty: 5 },           // not LSG → ignored
    { kind: 'item', reference: 'LSG-BBB', qty: 1, isOptional: true }, // optional → ignored
  ], byRef);
  assert.deepEqual([...units], [['lsg-111', 3]]);
});

// ── lsgCommitmentDeltas: the heart of robustness — idempotent, reversible
// desired-state reconciliation. delta = committed − desired (Shopify
// available-stock delta: negative deducts, positive restocks). ──────────────
test('first commit (nothing held → desired) deducts (negative deltas)', () => {
  const deltas = lsgCommitmentDeltas({}, { 'lsg-111': 2, 'lsg-222': 1 });
  assert.deepEqual(deltas, [
    { productId: 'lsg-111', delta: -2 },
    { productId: 'lsg-222', delta: -1 },
  ]);
});

test('full revert (held → nothing) restocks exactly what was taken (positive deltas)', () => {
  const deltas = lsgCommitmentDeltas({ 'lsg-111': 2, 'lsg-222': 1 }, {});
  assert.deepEqual(deltas, [
    { productId: 'lsg-111', delta: 2 },
    { productId: 'lsg-222', delta: 1 },
  ]);
});

test('re-running an already-committed quote is a no-op (idempotent)', () => {
  assert.deepEqual(lsgCommitmentDeltas({ 'lsg-111': 2 }, { 'lsg-111': 2 }), []);
});

test('a quantity change pushes only the difference, not the whole line', () => {
  // committed 1, desired 3 → deduct 2 more; another product unchanged.
  const deltas = lsgCommitmentDeltas({ 'lsg-111': 1, 'lsg-222': 4 }, { 'lsg-111': 3, 'lsg-222': 4 });
  assert.deepEqual(deltas, [{ productId: 'lsg-111', delta: -2 }]);
});

test('mixed: one product grows, another is fully released', () => {
  const deltas = lsgCommitmentDeltas({ 'lsg-111': 1, 'lsg-333': 2 }, { 'lsg-111': 2 });
  assert.deepEqual(deltas, [
    { productId: 'lsg-111', delta: -1 },  // deduct one more
    { productId: 'lsg-333', delta: 2 },   // restock the released two
  ]);
});

test('lsgCommitmentDeltas accepts Map snapshots and ignores zero/blank entries', () => {
  const committed = new Map([['lsg-111', 2], ['lsg-222', 0]]);
  assert.deepEqual(lsgCommitmentDeltas(committed, { 'lsg-111': 2 }), []);
});

// ── quoteHoldsLsgStock: the gate that decides deduct-vs-restock. ────────────
test('quoteHoldsLsgStock: accepted + live order holds stock', () => {
  assert.equal(quoteHoldsLsgStock({ status: 'accepted', orderId: 'o1' }, { status: 'draft' }), true);
  assert.equal(quoteHoldsLsgStock({ status: 'accepted', orderId: 'o1' }, { status: 'received' }), true);
});

test('quoteHoldsLsgStock: a floor sale (no order) holds once the deposit is received', () => {
  // The usual LSG path — warehouse stock sold off the floor, never attached to
  // an order. Accepted alone is not yet a commitment; the deposit is (same
  // signal as readyToInvoice / quoteOutstanding).
  assert.equal(quoteHoldsLsgStock({ status: 'accepted', orderId: null, depositReceivedAt: 1700000000000 }, null), true);
  assert.equal(quoteHoldsLsgStock({ status: 'accepted', orderId: null, depositReceivedAt: null }, null), false);
  // Un-marking the deposit releases the hold (→ restock).
  assert.equal(quoteHoldsLsgStock({ status: 'accepted', orderId: null }, null), false);
});

test('quoteHoldsLsgStock: a deposit on a non-accepted floor-sale quote never holds', () => {
  assert.equal(quoteHoldsLsgStock({ status: 'declined', orderId: null, depositReceivedAt: 1700000000000 }, null), false);
  assert.equal(quoteHoldsLsgStock({ status: 'archived', orderId: null, depositReceivedAt: 1700000000000 }, null), false);
});

test('quoteHoldsLsgStock: not held when un-accepted, unattached, declined, or order cancelled/missing', () => {
  assert.equal(quoteHoldsLsgStock({ status: 'sent', orderId: 'o1' }, { status: 'draft' }), false);
  assert.equal(quoteHoldsLsgStock({ status: 'declined', orderId: 'o1' }, { status: 'draft' }), false);
  assert.equal(quoteHoldsLsgStock({ status: 'accepted', orderId: null }, null), false);
  assert.equal(quoteHoldsLsgStock({ status: 'accepted', orderId: 'o1' }, { status: 'cancelled' }), false);
  assert.equal(quoteHoldsLsgStock({ status: 'accepted', orderId: 'o1' }, null), false);  // order deleted
});
