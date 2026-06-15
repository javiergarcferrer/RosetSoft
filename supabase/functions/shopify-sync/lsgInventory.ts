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
  /** The input items Shopify actually applied (resolved + landed) — so the
   *  caller's commitment ledger advances for exactly these and a partial push
   *  is simply retried next time, never lost or double-counted. */
  applied: LsgAdjustment[];
}

export interface LsgAdjustOptions {
  /** Forwarded to the @idempotent directive (REQUIRED by Admin API 2026-04) so
   *  a retried request can't double-apply the signed deltas. One is generated
   *  when the caller omits it. */
  idempotencyKey?: string;
  /** Stored as the adjustment's referenceDocumentUri (Shopify audit trail). */
  reference?: string;
}

/** Rebuild the Shopify variant GID from an `lsg-<id>` product id or raw id. */
function variantGid(raw: string): string | null {
  const tail = String(raw || '').replace(/^lsg-/, '').split('/').pop() || '';
  return /^\d+$/.test(tail) ? `gid://shopify/ProductVariant/${tail}` : null;
}

export async function adjustLsgInventory(
  gql: Gql,
  adjustments: LsgAdjustment[],
  opts: LsgAdjustOptions = {},
): Promise<LsgAdjustResult> {
  const out: LsgAdjustResult = { ok: true, adjusted: 0, skipped: 0, errors: [], applied: [] };
  const items = (adjustments || []).filter((a) => a && Number.isFinite(a.delta) && Math.trunc(a.delta) !== 0);
  if (!items.length) return out;

  const locationId = (await gql<{ locations: { nodes: { id: string }[] } }>(
    `{ locations(first: 1) { nodes { id } } }`,
  )).locations.nodes[0]?.id ?? null;
  if (!locationId) { out.ok = false; out.errors.push('La tienda no expone una ubicación de inventario.'); return out; }

  // Resolve each variant's inventory item, then ONE batched adjustment. Track
  // the input items that make it into the batch so we can echo back exactly
  // what landed (a variant we can't resolve is skipped, never thrown).
  const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];
  const applied: LsgAdjustment[] = [];
  for (const a of items) {
    const gid = variantGid(a.variantId || a.productId || '');
    if (!gid) { out.skipped++; continue; }
    try {
      const inv = (await gql<{ productVariant: { inventoryItem: { id: string } | null } | null }>(
        `query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`,
        { id: gid },
      )).productVariant?.inventoryItem?.id ?? null;
      if (!inv) { out.skipped++; continue; }
      const delta = Math.trunc(a.delta);
      changes.push({ inventoryItemId: inv, locationId, delta });
      applied.push({ productId: a.productId, variantId: a.variantId, delta });
    } catch (e) {
      out.errors.push(`${a.variantId || a.productId}: ${(e as Error).message}`);
    }
  }
  if (!changes.length) { out.ok = out.errors.length === 0; return out; }

  // As of Admin API 2026-04 the @idempotent(key:) directive is REQUIRED on
  // inventoryAdjustQuantities. referenceDocumentUri is optional — a stable URI
  // for the change in Shopify's inventory history (audit trail).
  const input: Record<string, unknown> = { name: 'available', reason: 'correction', changes };
  if (opts.reference) input.referenceDocumentUri = opts.reference;
  const idempotencyKey = opts.idempotencyKey || crypto.randomUUID();

  try {
    const res = await gql<{ inventoryAdjustQuantities: { userErrors: { field: string[]; message: string }[] } }>(
      `mutation($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          userErrors { field message }
        }
      }`,
      { input, idempotencyKey },
    );
    const ue = res.inventoryAdjustQuantities.userErrors;
    if (ue.length) { out.ok = false; out.errors.push(...ue.map((e) => e.message)); }
    else { out.adjusted = changes.length; out.applied = applied; }
  } catch (e) {
    out.ok = false; out.errors.push((e as Error).message);
  }
  return out;
}
