// LSG inventory write-back — the PUSH half of the two-way LifestyleGarden sync.
//
// The catalog PULL keeps `products.stock_qty` fresh FROM the lifestylegarden.do
// Shopify store; this closes the loop the OTHER way: when an LSG product is sold
// inside ALCOVER (a quote accepted → order placed), decrement that variant's
// available count on Shopify so its storefront can't oversell the same piece.
//
// An LSG product id is `lsg-<variantId>` (catalogImport.ts), where variantId is
// the numeric tail of the Shopify ProductVariant GID — so we rebuild the GID,
// resolve its inventory item, and post ONE batched signed-delta adjustment
// against the store's primary location. Best-effort: a variant we can't resolve
// is skipped, never throwing, so one bad line can't sink a multi-line sale.

import type { Gql } from './client.ts';

export interface LsgAdjustment {
  /** `lsg-<variantId>` product id, or a raw variant id/GID. */
  productId?: string;
  variantId?: string;
  /** Signed change to available units — negative for a sale. */
  delta: number;
}

export interface LsgAdjustResult {
  ok: boolean;
  adjusted: number;
  skipped: number;
  errors: string[];
}

/** Rebuild the Shopify variant GID from an `lsg-<id>` product id or raw id. */
function variantGid(raw: string): string | null {
  const tail = String(raw || '').replace(/^lsg-/, '').split('/').pop() || '';
  return /^\d+$/.test(tail) ? `gid://shopify/ProductVariant/${tail}` : null;
}

export async function adjustLsgInventory(gql: Gql, adjustments: LsgAdjustment[]): Promise<LsgAdjustResult> {
  const out: LsgAdjustResult = { ok: true, adjusted: 0, skipped: 0, errors: [] };
  const items = (adjustments || []).filter((a) => a && Number.isFinite(a.delta) && Math.trunc(a.delta) !== 0);
  if (!items.length) return out;

  const locationId = (await gql<{ locations: { nodes: { id: string }[] } }>(
    `{ locations(first: 1) { nodes { id } } }`,
  )).locations.nodes[0]?.id ?? null;
  if (!locationId) { out.ok = false; out.errors.push('La tienda no expone una ubicación de inventario.'); return out; }

  // Resolve each variant's inventory item, then ONE batched adjustment.
  const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];
  for (const a of items) {
    const gid = variantGid(a.variantId || a.productId || '');
    if (!gid) { out.skipped++; continue; }
    try {
      const inv = (await gql<{ productVariant: { inventoryItem: { id: string } | null } | null }>(
        `query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`,
        { id: gid },
      )).productVariant?.inventoryItem?.id ?? null;
      if (!inv) { out.skipped++; continue; }
      changes.push({ inventoryItemId: inv, locationId, delta: Math.trunc(a.delta) });
    } catch (e) {
      out.errors.push(`${a.variantId || a.productId}: ${(e as Error).message}`);
    }
  }
  if (!changes.length) { out.ok = out.errors.length === 0; return out; }

  try {
    const res = await gql<{ inventoryAdjustQuantities: { userErrors: { field: string[]; message: string }[] } }>(
      `mutation($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) { userErrors { field message } }
      }`,
      { input: { name: 'available', reason: 'correction', changes } },
    );
    const ue = res.inventoryAdjustQuantities.userErrors;
    if (ue.length) { out.ok = false; out.errors.push(...ue.map((e) => e.message)); }
    else out.adjusted = changes.length;
  } catch (e) {
    out.ok = false; out.errors.push((e as Error).message);
  }
  return out;
}
