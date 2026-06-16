// LSG inventory write-back — the PUSH half of the two-way LifestyleGarden sync.
//
// The catalog PULL keeps `products.stock_qty` fresh FROM the lifestylegarden.do
// Shopify store; this closes the loop the OTHER way: when an LSG product is sold
// inside ALCOVER (a quote committed to a sale), lower that variant's PHYSICAL
// stock on Shopify so its storefront can't oversell the same piece.
//
// WHAT we write, and WHY on_hand (not available) — per shopify.dev's
// inventory-states model (Admin API 2026-04):
//   • `on_hand`   = the total units PHYSICALLY at a location;
//   • `available` = the sellable subset, DERIVED as
//     on_hand − committed − reserved − damaged − safety_stock − quality_control.
//   A piece we sold off the floor physically LEFT, outside Shopify's own order
//   flow, so the correct lever is `on_hand` — `available` then recomputes for
//   free. Writing `available` directly would leave `on_hand` inflated and the
//   books would double-count the piece if a storefront order ever fulfilled it
//   (and an app can't touch the `committed` bucket at all). on_hand has no delta
//   mutation (inventoryAdjustQuantities rejects it), so we read the current
//   on_hand and SET current+delta via inventorySetQuantities (the non-deprecated
//   replacement for inventorySetOnHandQuantities).
//
// WHICH location — the reason a naive push silently does nothing: an item is
// only adjustable at a location where it is STOCKED, and only reaches the
// storefront from a location that FULFILLS ONLINE ORDERS. `locations(first:1)`
// grabs an arbitrary (maybe inactive / non-online / non-stocking) location, so
// the mutation either errors with `item_not_stocked_at_location` (swallowed as a
// no-op) or lands somewhere the storefront never reads. We instead resolve the
// variant's OWN stocked levels and pick its active + online-fulfilling one.
//
// An LSG product id is `lsg-<variantId>` (catalogImport.ts), where variantId is
// the numeric tail of the Shopify ProductVariant GID. Best-effort: a variant we
// can't resolve (no inventory item, untracked, or stocked nowhere usable) is
// SKIPPED with a surfaced reason, never thrown — so one bad line can't sink a
// multi-line sale, and a real failure is visible instead of a silent no-op.

import type { Gql } from './client.ts';

export interface LsgAdjustment {
  /** `lsg-<variantId>` product id, or a raw variant id/GID. */
  productId?: string;
  variantId?: string;
  /** Signed change to physical (on_hand) units — negative for a sale. */
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
   *  a retried request can't double-apply the change. One is generated when the
   *  caller omits it. */
  idempotencyKey?: string;
  /** Stored as the set's referenceDocumentUri (Shopify audit trail). */
  reference?: string;
}

/** Rebuild the Shopify variant GID from an `lsg-<id>` product id or raw id. */
function variantGid(raw: string): string | null {
  const tail = String(raw || '').replace(/^lsg-/, '').split('/').pop() || '';
  return /^\d+$/.test(tail) ? `gid://shopify/ProductVariant/${tail}` : null;
}

interface InvLevel {
  location: { id: string; isActive: boolean; fulfillsOnlineOrders: boolean } | null;
  quantities: { name: string; quantity: number }[] | null;
}
interface InvItem {
  id: string;
  tracked: boolean;
  inventoryLevels: { nodes: InvLevel[] } | null;
}

/**
 * Pick the level to adjust for an item: its ACTIVE, online-order-fulfilling
 * stocked location (what the storefront actually sells from); failing that any
 * active stocked location; failing that the first stocked one. Returns null when
 * the item is stocked nowhere (→ can't be adjusted; skipped with a reason).
 */
function chooseLevel(levels: InvLevel[]): InvLevel | null {
  const stocked = levels.filter((l) => l.location?.id);
  return (
    stocked.find((l) => l.location!.isActive && l.location!.fulfillsOnlineOrders) ??
    stocked.find((l) => l.location!.isActive) ??
    stocked[0] ??
    null
  );
}

function onHandOf(level: InvLevel): number {
  const q = (level.quantities || []).find((x) => x.name === 'on_hand');
  return Number(q?.quantity) || 0;
}

export async function adjustLsgInventory(
  gql: Gql,
  adjustments: LsgAdjustment[],
  opts: LsgAdjustOptions = {},
): Promise<LsgAdjustResult> {
  const out: LsgAdjustResult = { ok: true, adjusted: 0, skipped: 0, errors: [], applied: [] };
  const items = (adjustments || []).filter((a) => a && Number.isFinite(a.delta) && Math.trunc(a.delta) !== 0);
  if (!items.length) return out;

  // Resolve each variant to the exact (inventoryItem, location, current on_hand)
  // we'll set, and compute the new ABSOLUTE on_hand (current + signed delta,
  // floored at 0 so a sale can never push Shopify negative). Track the input
  // items that make it into the batch so we echo back exactly what landed.
  const setQuantities: Array<{ inventoryItemId: string; locationId: string; quantity: number }> = [];
  const applied: LsgAdjustment[] = [];
  for (const a of items) {
    const gid = variantGid(a.variantId || a.productId || '');
    if (!gid) { out.skipped++; continue; }
    const ref = a.variantId || a.productId;
    try {
      const inv = (await gql<{ productVariant: { inventoryItem: InvItem | null } | null }>(
        `query($id: ID!) {
          productVariant(id: $id) {
            inventoryItem {
              id
              tracked
              inventoryLevels(first: 20) {
                nodes {
                  location { id isActive fulfillsOnlineOrders }
                  quantities(names: ["on_hand"]) { name quantity }
                }
              }
            }
          }
        }`,
        { id: gid },
      )).productVariant?.inventoryItem ?? null;

      if (!inv?.id) { out.skipped++; continue; }
      // An UNTRACKED item accepts a set and reports success but never moves the
      // visible count — surface it rather than report a phantom decrement.
      if (inv.tracked === false) {
        out.skipped++;
        out.errors.push(`${ref}: el seguimiento de inventario está desactivado en Shopify para este artículo.`);
        continue;
      }
      const level = chooseLevel(inv.inventoryLevels?.nodes ?? []);
      if (!level) {
        out.skipped++;
        out.errors.push(`${ref}: el artículo no está almacenado en ninguna ubicación de la tienda.`);
        continue;
      }
      const next = Math.max(0, onHandOf(level) + Math.trunc(a.delta));
      setQuantities.push({ inventoryItemId: inv.id, locationId: level.location!.id, quantity: next });
      applied.push({ productId: a.productId, variantId: a.variantId, delta: Math.trunc(a.delta) });
    } catch (e) {
      out.errors.push(`${ref}: ${(e as Error).message}`);
    }
  }
  if (!setQuantities.length) { out.ok = out.errors.length === 0; return out; }

  // Set the new on_hand for every resolved item in ONE batched mutation. As of
  // Admin API 2026-04 @idempotent(key:) is REQUIRED; referenceDocumentUri is the
  // app's stamp in Shopify's inventory history (audit trail). `available`
  // recomputes from the new on_hand automatically.
  const input: Record<string, unknown> = { name: 'on_hand', reason: 'correction', quantities: setQuantities };
  if (opts.reference) input.referenceDocumentUri = opts.reference;
  const idempotencyKey = opts.idempotencyKey || crypto.randomUUID();

  try {
    const res = await gql<{ inventorySetQuantities: { userErrors: { field: string[]; message: string }[] } }>(
      `mutation($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          userErrors { field message }
        }
      }`,
      { input, idempotencyKey },
    );
    const ue = res.inventorySetQuantities.userErrors;
    if (ue.length) { out.ok = false; out.errors.push(...ue.map((e) => e.message)); }
    else { out.adjusted = setQuantities.length; out.applied = applied; }
  } catch (e) {
    out.ok = false; out.errors.push((e as Error).message);
  }
  return out;
}
