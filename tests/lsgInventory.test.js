// shopify-sync LSG inventory write-back (supabase/functions/shopify-sync/
// lsgInventory.ts) — the Shopify push that backs accept→deduct / revert→restock.
//
// Pins the BEST-PRACTICE invariants the dealer's stock integrity rides on:
//   • we write the PHYSICAL `on_hand` state via inventorySetQuantities (NOT a
//     `available` delta) — on_hand is the correct lever for a piece that left
//     the floor outside Shopify's order flow; `available` recomputes from it.
//     We read the current on_hand and SET current+delta (floored at 0).
//   • we adjust the variant's OWN stocked, active, online-order-fulfilling
//     location — never a blind locations(first:1) that may not stock the item
//     (which silently no-ops as `item_not_stocked_at_location`).
//   • untracked items + items stocked nowhere are SKIPPED with a surfaced
//     reason — never reported as a phantom decrement.
//   • the @idempotent(key:) directive is present + the key is threaded — Admin
//     API 2026-04 REQUIRES it (a retried push can't double-apply).
//   • each quantity row carries `changeFromQuantity` = the on_hand we read —
//     REQUIRED by Admin API 2026-04 (compareQuantity/ignoreCompareQuantity were
//     removed) and the compare-and-swap that stops a concurrent writer from
//     being clobbered (the set is rejected, not overwritten with a stale base).
//   • the audit-trail referenceDocumentUri is forwarded;
//   • the result echoes back EXACTLY the items that landed (`applied`), so the
//     caller's commitment ledger advances only for real changes;
//   • a userError fails closed (ok=false, nothing reported applied).
//
// `adjustLsgInventory` takes a `gql` function, so we drive it with a fake that
// records the mutation — no Deno, no network (same Node-import seam as stores.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustLsgInventory } from '../supabase/functions/shopify-sync/lsgInventory.ts';

// A fake Shopify gql: resolves variant → inventory item with its stocked levels,
// then records the on_hand set mutation. Knobs let a test shape the variant.
//   • 333 → no inventory item (skipped);
//   • 444 → tracked:false (skipped, surfaced);
//   • 555 → stocked at no location (skipped, surfaced);
//   • 666 → two locations: an inactive/non-online one FIRST, then the real one,
//           to prove the chooser prefers active + fulfillsOnlineOrders;
//   • everything else → one active, online-fulfilling location with `onHand`.
function makeGql({ mutationUserErrors = [], onHand = 10 } = {}) {
  const calls = { mutation: null };
  const lvl = (id, isActive, fulfillsOnlineOrders, q) => ({
    location: { id, isActive, fulfillsOnlineOrders },
    quantities: [{ name: 'on_hand', quantity: q }],
  });
  const gql = async (query, variables = {}) => {
    if (query.includes('productVariant(id:')) {
      const id = String(variables.id || '');
      const tail = id.split('/').pop();
      const itemId = `gid://shopify/InventoryItem/${tail}`;
      if (tail === '333') return { productVariant: { inventoryItem: null } };
      if (tail === '444') return { productVariant: { inventoryItem: { id: itemId, tracked: false, inventoryLevels: { nodes: [lvl('gid://shopify/Location/1', true, true, onHand)] } } } };
      if (tail === '555') return { productVariant: { inventoryItem: { id: itemId, tracked: true, inventoryLevels: { nodes: [] } } } };
      if (tail === '666') return { productVariant: { inventoryItem: { id: itemId, tracked: true, inventoryLevels: { nodes: [
        lvl('gid://shopify/Location/warehouse', true, false, 99),  // active but not online → skip
        lvl('gid://shopify/Location/store', true, true, onHand),   // the right one
      ] } } } };
      return { productVariant: { inventoryItem: { id: itemId, tracked: true, inventoryLevels: { nodes: [lvl('gid://shopify/Location/1', true, true, onHand)] } } } };
    }
    if (query.includes('inventorySetQuantities')) {
      calls.mutation = { query, variables };
      return { inventorySetQuantities: { userErrors: mutationUserErrors } };
    }
    throw new Error(`unexpected query: ${query}`);
  };
  return { gql, calls };
}

test('SETS on_hand (current + delta) via inventorySetQuantities, with @idempotent + reference', async () => {
  const { gql, calls } = makeGql({ onHand: 10 });
  const res = await adjustLsgInventory(
    gql,
    [{ productId: 'lsg-111', delta: -2 }],
    { idempotencyKey: 'key-abc', reference: 'alcoversoft://quote/q1' },
  );

  assert.ok(calls.mutation, 'the set mutation was sent');
  // 2026-04 requires the directive — pin both the directive and its variable.
  assert.match(calls.mutation.query, /inventorySetQuantities/);
  assert.match(calls.mutation.query, /@idempotent\(key:\s*\$idempotencyKey\)/);
  assert.match(calls.mutation.query, /\$idempotencyKey:\s*String!/);
  assert.equal(calls.mutation.variables.idempotencyKey, 'key-abc');
  // Audit trail + the PHYSICAL state, not `available`.
  assert.equal(calls.mutation.variables.input.referenceDocumentUri, 'alcoversoft://quote/q1');
  assert.equal(calls.mutation.variables.input.reason, 'correction');
  assert.equal(calls.mutation.variables.input.name, 'on_hand');
  // One resolved item: on_hand SET to 10 + (-2) = 8, at the active online
  // location, with changeFromQuantity = the read on_hand (10) for compare-and-swap.
  assert.deepEqual(calls.mutation.variables.input.quantities, [
    { inventoryItemId: 'gid://shopify/InventoryItem/111', locationId: 'gid://shopify/Location/1', quantity: 8, changeFromQuantity: 10 },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.applied, [{ productId: 'lsg-111', variantId: undefined, delta: -2 }]);
});

test('a positive delta (restock) raises on_hand; on_hand is floored at 0', async () => {
  const { gql, calls } = makeGql({ onHand: 1 });
  const res = await adjustLsgInventory(
    gql,
    [
      { productId: 'lsg-111', delta: 3 },   // 1 + 3 = 4
      { productId: 'lsg-222', delta: -5 },  // 1 - 5 = -4 → floored to 0
    ],
    { idempotencyKey: 'k' },
  );
  assert.equal(res.adjusted, 2);
  assert.deepEqual(calls.mutation.variables.input.quantities, [
    { inventoryItemId: 'gid://shopify/InventoryItem/111', locationId: 'gid://shopify/Location/1', quantity: 4, changeFromQuantity: 1 },
    { inventoryItemId: 'gid://shopify/InventoryItem/222', locationId: 'gid://shopify/Location/1', quantity: 0, changeFromQuantity: 1 },
  ]);
});

test('adjusts the variant\'s active, online-order-fulfilling location — not just the first', async () => {
  const { gql, calls } = makeGql({ onHand: 4 });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-666', delta: -1 }], { idempotencyKey: 'k' });
  assert.equal(res.ok, true);
  // Picks the online store location (on_hand 4 → 3), NOT the warehouse (99);
  // changeFromQuantity reflects THAT location's on_hand (4), not the warehouse's.
  assert.deepEqual(calls.mutation.variables.input.quantities, [
    { inventoryItemId: 'gid://shopify/InventoryItem/666', locationId: 'gid://shopify/Location/store', quantity: 3, changeFromQuantity: 4 },
  ]);
});

test('an unresolved / untracked / unstocked variant is skipped (surfaced), the rest land', async () => {
  const { gql, calls } = makeGql({ onHand: 10 });
  const res = await adjustLsgInventory(
    gql,
    [
      { productId: 'lsg-111', delta: -1 },
      { productId: 'lsg-333', delta: -1 }, // no inventory item
      { productId: 'lsg-444', delta: -1 }, // not tracked
      { productId: 'lsg-555', delta: -1 }, // stocked nowhere
      { productId: 'lsg-222', delta: 3 },  // a restock (positive)
    ],
    { idempotencyKey: 'k' },
  );

  assert.equal(res.skipped, 3);
  assert.equal(res.adjusted, 2);
  // Untracked + unstocked surface a reason so a real failure isn't a silent no-op.
  assert.equal(res.errors.length, 2);
  assert.ok(res.errors.some((e) => e.includes('lsg-444') && e.includes('seguimiento')));
  assert.ok(res.errors.some((e) => e.includes('lsg-555') && e.includes('ubicación')));
  // applied echoes ONLY what landed — the ledger advances for exactly these.
  assert.deepEqual(res.applied, [
    { productId: 'lsg-111', variantId: undefined, delta: -1 },
    { productId: 'lsg-222', variantId: undefined, delta: 3 },
  ]);
  assert.equal(calls.mutation.variables.input.quantities.length, 2);
});

test('a Shopify userError fails closed — nothing reported applied', async () => {
  const { gql } = makeGql({ mutationUserErrors: [{ field: ['input'], message: 'boom' }] });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: -1 }], { idempotencyKey: 'k' });
  assert.equal(res.ok, false);
  assert.deepEqual(res.applied, []);
  assert.equal(res.adjusted, 0);
  assert.deepEqual(res.errors, ['boom']);
});

test('no-op inputs never hit the network', async () => {
  const { gql, calls } = makeGql();
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: 0 }], { idempotencyKey: 'k' });
  assert.equal(calls.mutation, null);
  assert.deepEqual(res.applied, []);
});
