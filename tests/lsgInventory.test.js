// shopify-sync LSG inventory write-back (supabase/functions/shopify-sync/
// lsgInventory.ts) — the Shopify push that backs accept→deduct / revert→restock.
//
// Pins the BEST-PRACTICE invariants the dealer's stock integrity rides on:
//   • we write the PHYSICAL `on_hand` state via inventorySetQuantities (NOT a
//     `available` delta) — on_hand is the correct lever for a piece that left
//     the floor outside Shopify's order flow; `available` recomputes from it.
//     We read the current on_hand and SET current+delta (floored at 0).
//   • we adjust a STOCKED location that holds units (on_hand > 0) — never a
//     blind locations(first:1) that may not stock the item (which silently
//     no-ops as `item_not_stocked_at_location`). We resolve it from
//     `location.id` + on_hand only (both under read_inventory), NOT the
//     read_locations-gated isActive/fulfillsOnlineOrders fields — a
//     managed-install client-credentials token can't read those until a new app
//     version ships, so requesting them 403s the whole push (ACCESS_DENIED).
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
import { ShopifyAccessDeniedError } from '../supabase/functions/shopify-sync/stores.ts';

// A fake Shopify gql: resolves variant → inventory item with its stocked levels,
// then records the on_hand set mutation. Knobs let a test shape the variant.
//   • 333 → no inventory item (skipped);
//   • 444 → tracked:false (skipped, surfaced);
//   • 555 → stocked at no location (skipped, surfaced);
//   • 666 → two locations: a warehouse (active, NOT online; holds 99) FIRST,
//           then the online store (active + online; holds `onHand`) — proves the
//           chooser prefers the active + online-fulfilling location with the
//           rich query, and (under denyLocationFields) the held-stock proxy.
//   • everything else → one active, online, stocked location with `onHand`.
//
// The response is SHAPED to the query's selection set: the rich query (asks for
// isActive/fulfillsOnlineOrders) gets them; the lean fallback gets `location
// { id }` only. `denyLocationFields` makes the rich query raise the typed
// ShopifyAccessDeniedError on a location field (simulating a token without
// read_locations), so we can pin the graceful degradation to the lean query.
//
// The post-set storefront-visibility reconcile is also driven here: a
// `product(id:)` read answers with { status, variants→inventoryItem→levels of
// `available` } and the `productUpdate` mutation is recorded. The decision is
// summed from the variants' inventory-LEVEL available (NOT product.totalInventory,
// which lags) — `productAvailable`/`productStatus`/`productTracked` (default
// 10/ACTIVE/true → no flip) shape the scenario; `denyProductWrite` makes
// productUpdate raise ShopifyAccessDeniedError (token without write_products).
function makeGql({
  mutationUserErrors = [], onHand = 10, denyLocationFields = false,
  productStatus = 'ACTIVE', productAvailable = 10, productTracked = true, productUpdateUserErrors = [], denyProductWrite = false,
} = {}) {
  const calls = { mutation: null, denied: 0, productUpdates: [], statusReads: 0 };
  const L = (id, isActive, online, q) => ({ id, isActive, online, q });
  const shape = (rich, l) => ({
    location: rich ? { id: l.id, isActive: l.isActive, fulfillsOnlineOrders: l.online } : { id: l.id },
    quantities: [{ name: 'on_hand', quantity: l.q }],
  });
  const levelsFor = (tail) => tail === '666'
    ? [L('gid://shopify/Location/warehouse', true, false, 99), L('gid://shopify/Location/store', true, true, onHand)]
    : [L('gid://shopify/Location/1', true, true, onHand)];
  const item = (rich, tail, tracked, levels) => ({
    productVariant: { product: { id: `gid://shopify/Product/${tail}` }, inventoryItem: { id: `gid://shopify/InventoryItem/${tail}`, tracked, inventoryLevels: { nodes: levels.map((l) => shape(rich, l)) } } },
  });
  const gql = async (query, variables = {}) => {
    if (query.includes('productVariant(id:')) {
      const rich = query.includes('isActive');
      if (rich && denyLocationFields) {
        calls.denied++;
        throw new ShopifyAccessDeniedError('alcoversrl.myshopify.com', 'productVariant.inventoryItem.inventoryLevels.nodes.0.location.isActive');
      }
      const tail = String(variables.id || '').split('/').pop();
      if (tail === '333') return { productVariant: { inventoryItem: null } };
      if (tail === '444') return item(rich, tail, false, levelsFor(tail));
      if (tail === '555') return item(rich, tail, true, []);
      return item(rich, tail, true, levelsFor(tail));
    }
    if (query.includes('product(id:')) {
      calls.statusReads++;
      return { product: { status: productStatus, variants: { nodes: [
        { inventoryItem: { tracked: productTracked, inventoryLevels: { nodes: [{ quantities: [{ name: 'available', quantity: productAvailable }] }] } } },
      ] } } };
    }
    if (query.includes('productUpdate')) {
      if (denyProductWrite) throw new ShopifyAccessDeniedError('alcoversrl.myshopify.com', 'productUpdate');
      calls.productUpdates.push(variables);
      return { productUpdate: { userErrors: productUpdateUserErrors } };
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

test('adjusts the active, online-order-fulfilling location (rich query) — not just the first', async () => {
  const { gql, calls } = makeGql({ onHand: 4 });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-666', delta: -1 }], { idempotencyKey: 'k' });
  assert.equal(res.ok, true);
  // Picks the online store location (on_hand 4 → 3), NOT the warehouse (active
  // but not online; holds 99); changeFromQuantity reflects THAT location's
  // on_hand (4), not the warehouse's.
  assert.deepEqual(calls.mutation.variables.input.quantities, [
    { inventoryItemId: 'gid://shopify/InventoryItem/666', locationId: 'gid://shopify/Location/store', quantity: 3, changeFromQuantity: 4 },
  ]);
});

test('degrades gracefully when read_locations is missing: rich query ACCESS_DENIED → lean fallback, push still lands', async () => {
  const { gql, calls } = makeGql({ onHand: 5, denyLocationFields: true });
  const res = await adjustLsgInventory(
    gql,
    [
      { productId: 'lsg-111', delta: -2 }, // 5 - 2 = 3
      { productId: 'lsg-222', delta: -1 }, // 5 - 1 = 4
    ],
    { idempotencyKey: 'k' },
  );
  // The missing scope NEVER hard-fails the push — it succeeds on the lean query.
  assert.equal(res.ok, true);
  assert.equal(res.adjusted, 2);
  assert.deepEqual(res.errors, []);
  // The rich query is attempted ONCE, denied, then the degrade is STICKY: the
  // second item goes straight to lean, so only a single denial is ever incurred.
  assert.equal(calls.denied, 1);
  // Lean fallback can't read active/online → targets a stocked location holding
  // units (here the single Location/1), with the read on_hand as changeFromQuantity.
  assert.deepEqual(calls.mutation.variables.input.quantities, [
    { inventoryItemId: 'gid://shopify/InventoryItem/111', locationId: 'gid://shopify/Location/1', quantity: 3, changeFromQuantity: 5 },
    { inventoryItemId: 'gid://shopify/InventoryItem/222', locationId: 'gid://shopify/Location/1', quantity: 4, changeFromQuantity: 5 },
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

/* --------------------- storefront visibility (out of stock → draft) --------------------- */

test('out of stock → DRAFT: a sale that empties a product hides it from the storefront', async () => {
  const { gql, calls } = makeGql({ onHand: 1, productStatus: 'ACTIVE', productAvailable: 0 });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: -1 }], { idempotencyKey: 'k' });
  assert.equal(res.ok, true);
  assert.equal(res.drafted, 1);
  assert.equal(res.republished, 0);
  assert.deepEqual(res.errors, []);
  // It read the product's status/total then set it to DRAFT — keyed on the
  // parent PRODUCT gid, not the variant/inventory item.
  assert.equal(calls.productUpdates.length, 1);
  assert.deepEqual(calls.productUpdates[0].product, { id: 'gid://shopify/Product/111', status: 'DRAFT' });
});

test('restock → ACTIVE: a revert that brings a drafted product back republishes it', async () => {
  const { gql, calls } = makeGql({ onHand: 0, productStatus: 'DRAFT', productAvailable: 3 });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: 3 }], { idempotencyKey: 'k' });
  assert.equal(res.ok, true);
  assert.equal(res.republished, 1);
  assert.equal(res.drafted, 0);
  assert.deepEqual(calls.productUpdates[0].product, { id: 'gid://shopify/Product/111', status: 'ACTIVE' });
});

test('idempotent: already DRAFT + still out of stock → no productUpdate (no updated_at churn)', async () => {
  const { gql, calls } = makeGql({ onHand: 1, productStatus: 'DRAFT', productAvailable: 0 });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: -1 }], { idempotencyKey: 'k' });
  assert.equal(res.ok, true);
  assert.equal(res.drafted, 0);
  assert.equal(res.republished, 0);
  assert.equal(calls.statusReads, 1);        // it checks…
  assert.equal(calls.productUpdates.length, 0); // …but writes nothing
});

test('restock decision uses inventory-LEVEL available (lag-free), so a republish lands the same push', async () => {
  // The bug a revert hit: product.totalInventory lagged at 0 right after the
  // restock, so the piece stayed DRAFT with stock. We sum the variants' level
  // `available` (here 1, freshly consistent) → DRAFT → ACTIVE in the same push.
  const { gql, calls } = makeGql({ onHand: 0, productStatus: 'DRAFT', productAvailable: 1 });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: 1 }], { idempotencyKey: 'k' });
  assert.equal(res.republished, 1);
  assert.deepEqual(calls.productUpdates[0].product, { id: 'gid://shopify/Product/111', status: 'ACTIVE' });
});

test('an untracked product is left alone (no tracked variant → visibility untouched)', async () => {
  const { gql, calls } = makeGql({ onHand: 1, productStatus: 'ACTIVE', productTracked: false, productAvailable: 0 });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: -1 }], { idempotencyKey: 'k' });
  assert.equal(res.ok, true);
  assert.equal(res.drafted, 0);
  assert.equal(calls.productUpdates.length, 0);
});

test('ARCHIVED / UNLISTED products are never touched by the visibility flip', async () => {
  for (const productStatus of ['ARCHIVED', 'UNLISTED']) {
    const { gql, calls } = makeGql({ onHand: 1, productStatus, productAvailable: 0 });
    const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: -1 }], { idempotencyKey: 'k' });
    assert.equal(res.ok, true, productStatus);
    assert.equal(res.drafted, 0, productStatus);
    assert.equal(calls.productUpdates.length, 0, productStatus);
  }
});

test('missing write_products degrades: stock still lands, visibility flip surfaced as a note (not fatal)', async () => {
  const { gql, calls } = makeGql({ onHand: 1, productStatus: 'ACTIVE', productAvailable: 0, denyProductWrite: true });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: -1 }], { idempotencyKey: 'k' });
  // The stock change still succeeded and is reported applied — the ledger advances.
  assert.equal(res.adjusted, 1);
  assert.deepEqual(res.applied, [{ productId: 'lsg-111', variantId: undefined, delta: -1 }]);
  assert.equal(res.drafted, 0);
  assert.equal(calls.productUpdates.length, 0);
  // The denial is surfaced (so the dealer can grant write_products) but doesn't
  // fail the push closed — ok stays true; only a soft note is added.
  assert.equal(res.errors.length, 1);
  assert.ok(res.errors[0].includes('write_products'));
});

test('the visibility flip runs once per PRODUCT, deduped across multiple lines', async () => {
  const { gql, calls } = makeGql({ onHand: 5, productStatus: 'ACTIVE', productAvailable: 0 });
  // Two lines of the SAME product (variant 111) → one set batch, one status read.
  const res = await adjustLsgInventory(
    gql,
    [{ variantId: '111', delta: -1 }, { variantId: '111', delta: -1 }],
    { idempotencyKey: 'k' },
  );
  assert.equal(res.ok, true);
  assert.equal(calls.statusReads, 1);
  assert.equal(calls.productUpdates.length, 1);
});

test('a visibility flip is skipped on a failed stock set (out.adjusted 0 → no status calls)', async () => {
  const { gql, calls } = makeGql({ mutationUserErrors: [{ field: ['input'], message: 'boom' }], productStatus: 'ACTIVE', productAvailable: 0 });
  const res = await adjustLsgInventory(gql, [{ productId: 'lsg-111', delta: -1 }], { idempotencyKey: 'k' });
  assert.equal(res.ok, false);
  assert.equal(calls.statusReads, 0);
  assert.equal(calls.productUpdates.length, 0);
});
