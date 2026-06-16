// Inventory PUSH — in-stock pieces → the Alcover store's admin catalog.
//
// The store catalog = in-stock inventory. Per item:
//   • in stock (qty > 0) AND priced (selling_price > 0) → upsert an ACTIVE
//     Shopify product (one listing per item, keyed by the stable handle
//     inv-<id>), set its price, on-hand quantity and photo, and place it in
//     the "Ligne Roset Inventory" collection (created if missing). It is NOT
//     pushed to the Online Store sales channel — the products live in the
//     Shopify admin so sales can be rung up there (draft orders / POS) or in
//     the quoting engine.
//   • otherwise, if it was previously synced → ARCHIVE it (leaves the
//     catalog). Catalog stays "in-stock only".
//
// The upsert/remove DECISION mirrors src/lib/inventoryShopify.ts
// (resolvePieceSync) across the Deno↔Vite wall; the shared handle rule lives
// in stores.ts (pinned equivalent by tests/shopifySync.test.js).

import { pieceHandle } from './stores.ts';
import type { Gql } from './client.ts';

const COLLECTION_TITLE = 'Ligne Roset Inventory';
const COLLECTION_HANDLE = 'ligne-roset-inventory';

export interface MirrorResult {
  synced: number;
  archived: number;
  skipped: number;
  errors: string[];
}

interface ItemRow {
  id: string;
  sku: string | null;
  name: string | null;
  qty_on_hand: number | null;
  selling_price: number | null;
  image_id: string | null;
  shopify_product_id: string | null;
}

// deno-lint-ignore no-explicit-any
export async function mirrorInventory(
  admin: any,
  team: string,
  gql: Gql,
  opts: { itemIds: string[] | null; supabaseUrl: string },
): Promise<MirrorResult> {
  // Items to reconcile: the requested ones, else everything that is either
  // already linked (so sold ones get archived) or priced (so it can publish).
  let q = admin.from('inventory_items')
    .select('id, sku, name, qty_on_hand, selling_price, image_id, shopify_product_id')
    .eq('profile_id', team);
  q = opts.itemIds ? q.in('id', opts.itemIds) : q.or('shopify_product_id.not.is.null,selling_price.gt.0');
  const { data: items } = await q;
  const out: MirrorResult = { synced: 0, archived: 0, skipped: 0, errors: [] };
  if (!items?.length) return out;

  // Resolve the location + the inventory collection once. Synced products are
  // grouped there (created as a manual collection if it doesn't exist yet)
  // instead of being published to the Online Store.
  let locationId: string | null = null;
  let collectionId: string | null = null;
  // Pick a location the storefront can actually read from: ACTIVE and
  // online-order-fulfilling, falling back to any active one. A blind
  // locations(first:1) can land on an inactive / non-online / non-stocking
  // location, where inventorySetQuantities fails `item_not_stocked_at_location`
  // (swallowed below) and the catalog shows in-stock pieces as quantity 0.
  const locs = (await gql<{ locations: { nodes: { id: string; isActive: boolean; fulfillsOnlineOrders: boolean }[] } }>(
    `{ locations(first: 25) { nodes { id isActive fulfillsOnlineOrders } } }`,
  )).locations.nodes ?? [];
  locationId = (locs.find((l) => l.isActive && l.fulfillsOnlineOrders)
    || locs.find((l) => l.isActive)
    || locs[0])?.id ?? null;
  const found = (await gql<{ collections: { nodes: { id: string }[] } }>(
    `query($q: String!) { collections(first: 1, query: $q) { nodes { id } } }`,
    { q: `handle:${COLLECTION_HANDLE}` },
  )).collections.nodes[0]?.id ?? null;
  if (found) {
    collectionId = found;
  } else {
    const created = await gql<{ collectionCreate: { collection: { id: string } | null; userErrors: { message: string }[] } }>(
      `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: { title: COLLECTION_TITLE, handle: COLLECTION_HANDLE } },
    );
    if (created.collectionCreate.userErrors.length) {
      throw new Error(created.collectionCreate.userErrors.map((e) => e.message).join('; '));
    }
    collectionId = created.collectionCreate.collection?.id ?? null;
  }

  for (const it of items as ItemRow[]) {
    try {
      const qty = Number(it.qty_on_hand) || 0;
      const price = Number(it.selling_price) || 0;
      const handle = pieceHandle(it.id);

      // Existing product id: stored link, else look up by stable handle.
      let pid: string | null = it.shopify_product_id || null;
      if (!pid) {
        const f = await gql<{ products: { nodes: { id: string }[] } }>(
          `query($q: String!) { products(first: 1, query: $q) { nodes { id } } }`,
          { q: `handle:${handle}` },
        );
        pid = f.products.nodes[0]?.id ?? null;
      }

      if (qty > 0 && price > 0) {
        // Photo: build the public URL from the receiving image's storage path.
        let imageUrl: string | null = null;
        if (it.image_id) {
          const { data: img } = await admin.from('images').select('storage_path').eq('id', it.image_id).maybeSingle();
          const p = (img as { storage_path?: string } | null)?.storage_path;
          if (p) imageUrl = `${opts.supabaseUrl}/storage/v1/object/public/images/${p}`;
        }

        const input: Record<string, unknown> = {
          handle,
          title: (it.name || it.sku || 'Artículo').trim(),
          status: 'ACTIVE',
          vendor: 'Ligne Roset',
          productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
          variants: [{
            sku: it.sku || '',
            price: price.toFixed(2),
            optionValues: [{ optionName: 'Title', name: 'Default Title' }],
            inventoryItem: { tracked: true },
          }],
        };
        if (pid) input.id = pid;
        if (imageUrl) input.files = [{ originalSource: imageUrl, contentType: 'IMAGE' }];
        // productSet's `collections` is a SET (replaces memberships) — these
        // products are owned by the sync, so their one home is the inventory
        // collection.
        if (collectionId) input.collections = [collectionId];

        const res = await gql<{ productSet: { product: { id: string; variants: { nodes: { inventoryItem: { id: string } | null }[] } } | null; userErrors: { field: string[]; message: string }[] } }>(
          `mutation($input: ProductSetInput!) {
            productSet(input: $input, synchronous: true) {
              product { id variants(first: 1) { nodes { inventoryItem { id } } } }
              userErrors { field message }
            }
          }`,
          { input },
        );
        const ue = res.productSet.userErrors;
        if (ue.length) throw new Error(ue.map((e) => e.message).join('; '));
        pid = res.productSet.product!.id;
        const invItemId = res.productSet.product!.variants.nodes[0]?.inventoryItem?.id ?? null;

        // Quantity (best-effort — a quantity hiccup must not block listing).
        // This is the sync's OWN product (not a contended SKU), so we ignore the
        // compare-and-swap by passing `changeFromQuantity: null` — REQUIRED as of
        // Admin API 2026-04, which removed `ignoreCompareQuantity` (omitting it
        // entirely now errors at runtime).
        if (invItemId && locationId) {
          try {
            await gql(
              `mutation($input: InventorySetQuantitiesInput!) {
                inventorySetQuantities(input: $input) { userErrors { field message } }
              }`,
              { input: { name: 'available', reason: 'correction',
                quantities: [{ inventoryItemId: invItemId, locationId, quantity: Math.floor(qty), changeFromQuantity: null }] } },
            );
          } catch (_) { /* leave qty for a later sync */ }
        }

        await admin.from('inventory_items')
          .update({ shopify_product_id: pid, shopify_synced_at: new Date().toISOString() })
          .eq('id', it.id);
        out.synced++;
      } else if (pid) {
        // Sold out / unpriced → leave the catalog (archive hides it everywhere).
        const res = await gql<{ productUpdate: { userErrors: { message: string }[] } }>(
          `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }`,
          { product: { id: pid, status: 'ARCHIVED' } },
        );
        const ue = res.productUpdate.userErrors;
        if (ue.length) throw new Error(ue.map((e) => e.message).join('; '));
        await admin.from('inventory_items')
          .update({ shopify_synced_at: new Date().toISOString() }).eq('id', it.id);
        out.archived++;
      } else {
        out.skipped++;
      }
    } catch (e) {
      out.errors.push(`${it.id}: ${(e as Error).message || e}`);
    }
  }

  return out;
}
