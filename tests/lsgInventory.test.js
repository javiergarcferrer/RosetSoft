// shopify-sync LSG inventory write-back (supabase/functions/shopify-sync/
// lsgInventory.ts) — the Shopify push that backs accept→deduct / revert→restock.
//
// Pins the BEST-PRACTICE invariants the dealer's stock integrity rides on:
//   • the @idempotent(key:) directive is present + the key is threaded — Admin
//     API 2026-04 REQUIRES it (a retried push can't double-apply a delta). A
//     regression here silently breaks every decrement, so it's pinned.
//   • the audit-trail referenceDocumentUri is forwarded;
//   • the result echoes back EXACTLY the items that landed (`applied`), with an
//     unresolved variant skipped (not applied) — so the caller's commitment
//     ledger advances only for real changes and a partial push is retried, not
//     lost or double-counted;
//   • a userError fails closed (ok=false, nothing reported applied).
//
// `adjustLsgInventory` takes a `gql` function, so we drive it with a fake that
// records the mutation — no Deno, no network (same Node-import seam as stores.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustLsgInventory } from '../supabase/functions/shopify-sync/lsgInventory.ts';

// A fake Shopify gql: answers the location lookup, resolves variant→inventory
// item (lsg-333 has none → skipped), and records the adjust mutation.
function makeGql({ mutationUserErrors = [] } = {}) {
  const calls = { mutation: null };
  const gql = async (query, variables = {}) => {
    if (query.includes('locations(first: 1)')) {
      return { locations: { nodes: [{ id: 'gid://shopify/Location/1' }] } };
    }
    if (query.includes('productVariant(id:')) {
      const id = String(variables.id || '');
      // 111 and 222 resolve; 333 has no inventory item (→ skipped).
      const item = id.endsWith('/333') ? null : { id: `gid://shopify/InventoryItem/${id.split('/').pop()}` };
      return { productVariant: item ? { inventoryItem: item } : { inventoryItem: null } };
    }
    if (query.includes('inventoryAdjustQuantities')) {
      calls.mutation = { query, variables };
      return { inventoryAdjustQuantities: { userErrors: mutationUserErrors } };
    }
    throw new Error(`unexpected query: ${query}`);
  };
  return { gql, calls };
}

test('sends the REQUIRED @idempotent directive with the threaded key + reference', async () => {
  const { gql, calls } = makeGql();
  const res = await adjustLsgInventory(
    gql,
    [{ productId: 'lsg-111', delta: -2 }],
    { idempotencyKey: 'key-abc', reference: 'rosetsoft://quote/q1' },
  );

  assert.ok(calls.mutation, 'the adjust mutation was sent');
  // 2026-04 requires the directive — pin both the directive and its variable.
  assert.match(calls.mutation.query, /@idempotent\(key:\s*\$idempotencyKey\)/);
  assert.match(calls.mutation.query, /\$idempotencyKey:\s*String!/);
  assert.equal(calls.mutation.variables.idempotencyKey, 'key-abc');
  // Audit trail + the documented reason/name.
  assert.equal(calls.mutation.variables.input.referenceDocumentUri, 'rosetsoft://quote/q1');
  assert.equal(calls.mutation.variables.input.reason, 'correction');
  assert.equal(calls.mutation.variables.input.name, 'available');
  // One resolved change with the signed delta.
  assert.deepEqual(calls.mutation.variables.input.changes, [
    { inventoryItemId: 'gid://shopify/InventoryItem/111', locationId: 'gid://shopify/Location/1', delta: -2 },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.applied, [{ productId: 'lsg-111', variantId: undefined, delta: -2 }]);
});

test('an unresolved variant is skipped, not applied; the rest still land', async () => {
  const { gql, calls } = makeGql();
  const res = await adjustLsgInventory(
    gql,
    [
      { productId: 'lsg-111', delta: -1 },
      { productId: 'lsg-333', delta: -1 }, // no inventory item → skipped
      { productId: 'lsg-222', delta: 3 },  // a restock (positive)
    ],
    { idempotencyKey: 'k' },
  );

  assert.equal(res.skipped, 1);
  assert.equal(res.adjusted, 2);
  // applied echoes ONLY what landed — the ledger advances for exactly these.
  assert.deepEqual(res.applied, [
    { productId: 'lsg-111', variantId: undefined, delta: -1 },
    { productId: 'lsg-222', variantId: undefined, delta: 3 },
  ]);
  assert.equal(calls.mutation.variables.input.changes.length, 2);
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
