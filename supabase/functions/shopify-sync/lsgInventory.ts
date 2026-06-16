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
//   (and an app can't touch the `committed` bucket at all). We read the current
//   on_hand and SET current+delta via inventorySetQuantities (the non-deprecated
//   replacement for inventorySetOnHandQuantities), passing the read value as
//   `changeFromQuantity` — REQUIRED by Admin API 2026-04 (compareQuantity/
//   ignoreCompareQuantity were removed) and the compare-and-swap that makes the
//   read-then-set safe against a concurrent writer (see the batch comment below).
//
// WHICH location — the reason a naive push silently does nothing: an item is
// only adjustable at a location where it is STOCKED, and only reaches the
// storefront from a location that FULFILLS ONLINE ORDERS. `locations(first:1)`
// grabs an arbitrary (maybe inactive / non-online / non-stocking) location, so
// the mutation either errors with `item_not_stocked_at_location` (swallowed as a
// no-op) or lands somewhere the storefront never reads. We resolve the variant's
// OWN stocked levels and pick its ACTIVE + online-fulfilling one (best practice).
//
// `location.isActive`/`fulfillsOnlineOrders` are gated behind `read_locations`.
// That scope is REQUIRED for accurate targeting and is normally present — but a
// managed-install client-credentials token can LAG a freshly-released scope (the
// token reflects the released app version, not the dashboard draft), and until
// it catches up, requesting those fields 403s the WHOLE query with ACCESS_DENIED.
// Rather than hard-fail the dealer's stock sync on that transient gap, we DEGRADE
// GRACEFULLY: the query is tried with the rich location fields first; on a
// location-scoped ACCESS_DENIED we fall back — sticky, for the rest of the push —
// to a lean `location { id }` query (covered by `read_inventory`, which the
// catalog pull already needs) and target the stocked location that actually
// HOLDS units (the best proxy when active/online can't be read). LSG is
// single-location, so the proxy lands on the same place; a multi-location store
// gets exact targeting as soon as read_locations is on the token.
//
// An LSG product id is `lsg-<variantId>` (catalogImport.ts), where variantId is
// the numeric tail of the Shopify ProductVariant GID. Best-effort: a variant we
// can't resolve (no inventory item, untracked, or stocked nowhere usable) is
// SKIPPED with a surfaced reason, never thrown — so one bad line can't sink a
// multi-line sale, and a real failure is visible instead of a silent no-op.

import type { Gql } from './client.ts';
import { ShopifyAccessDeniedError } from './stores.ts';

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
  // isActive/fulfillsOnlineOrders are read_locations-gated → present only on the
  // rich query; absent (undefined) on the lean fallback (see chooseLevel).
  location: { id: string; isActive?: boolean; fulfillsOnlineOrders?: boolean } | null;
  quantities: { name: string; quantity: number }[] | null;
}
interface InvItem {
  id: string;
  tracked: boolean;
  inventoryLevels: { nodes: InvLevel[] } | null;
}

/** The variant→inventory-item query. `rich` selects the read_locations-gated
 *  location fields used for accurate targeting; the lean form omits them so the
 *  push survives on read_inventory alone when read_locations isn't on the token. */
function variantQuery(rich: boolean): string {
  const locationFields = rich ? 'location { id isActive fulfillsOnlineOrders }' : 'location { id }';
  return `query($id: ID!) {
    productVariant(id: $id) {
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 20) {
          nodes {
            ${locationFields}
            quantities(names: ["on_hand"]) { name quantity }
          }
        }
      }
    }
  }`;
}

/** Did this access-denial concern a location field (→ we can degrade by dropping
 *  the read_locations-gated fields), as opposed to some other denied resource? */
function isLocationFieldDenied(e: unknown): boolean {
  return e instanceof ShopifyAccessDeniedError && e.field.includes('location');
}

/**
 * Pick the level to adjust for an item. When read_locations made the gated
 * fields available (the rich query), prefer the storefront's selling location:
 * ACTIVE + online-order-fulfilling, then any active. When those fields are
 * absent (the lean fallback — see header), prefer a stocked location that
 * actually HOLDS units (the one a sold-off-the-floor piece came from), then the
 * first stocked one (so a zero-stock item still resolves a valid location and
 * the floored set is a safe no-op). Returns null when the item is stocked
 * nowhere (→ can't be adjusted; skipped with a reason).
 */
function chooseLevel(levels: InvLevel[]): InvLevel | null {
  const stocked = levels.filter((l) => l.location?.id);
  if (!stocked.length) return null;
  return (
    stocked.find((l) => l.location!.isActive === true && l.location!.fulfillsOnlineOrders === true) ??
    stocked.find((l) => l.location!.isActive === true) ??
    stocked.find((l) => onHandOf(l) > 0) ??
    stocked[0]
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
  //
  // `changeFromQuantity` = the on_hand we just read. As of Admin API 2026-04 it
  // is REQUIRED on inventorySetQuantities (the old compareQuantity/
  // ignoreCompareQuantity fields were removed) — and it's the compare-and-swap
  // that makes the read-then-set safe: if anyone else (a storefront order, the
  // catalog cron, a concurrent sale) changed on_hand between our read and our
  // write, Shopify REJECTS the set with a userError instead of clobbering it
  // with our stale base (which would resurrect a sold unit → oversell). We fail
  // closed on that mismatch; the desired-state reconciler (lsgStock.js) re-reads
  // and re-applies on the next quote transition / lazy heal, so a rejected push
  // self-corrects rather than silently overselling.
  const setQuantities: Array<{ inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number }> = [];
  const applied: LsgAdjustment[] = [];

  // Start with the rich (read_locations) query for accurate targeting; the
  // FIRST location-scoped ACCESS_DENIED flips this STICKY false so the rest of
  // the batch goes straight to the lean query — we degrade once, never per item.
  let richLocations = true;
  async function fetchInventoryItem(gid: string): Promise<InvItem | null> {
    const run = (rich: boolean) =>
      gql<{ productVariant: { inventoryItem: InvItem | null } | null }>(variantQuery(rich), { id: gid })
        .then((r) => r.productVariant?.inventoryItem ?? null);
    if (!richLocations) return run(false);
    try {
      return await run(true);
    } catch (e) {
      if (!isLocationFieldDenied(e)) throw e;
      richLocations = false; // read_locations not on the token → degrade for the push
      return run(false);
    }
  }

  for (const a of items) {
    const gid = variantGid(a.variantId || a.productId || '');
    if (!gid) { out.skipped++; continue; }
    const ref = a.variantId || a.productId;
    try {
      const inv = await fetchInventoryItem(gid);

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
      const current = onHandOf(level);
      const next = Math.max(0, current + Math.trunc(a.delta));
      setQuantities.push({ inventoryItemId: inv.id, locationId: level.location!.id, quantity: next, changeFromQuantity: current });
      applied.push({ productId: a.productId, variantId: a.variantId, delta: Math.trunc(a.delta) });
    } catch (e) {
      out.errors.push(`${ref}: ${(e as Error).message}`);
    }
  }
  if (!setQuantities.length) { out.ok = out.errors.length === 0; return out; }

  // Set the new on_hand for every resolved item in ONE batched mutation. As of
  // Admin API 2026-04 @idempotent(key:) is REQUIRED (a retried push can't
  // double-apply) and each row's `changeFromQuantity` is REQUIRED (compare-and-
  // swap, set above). referenceDocumentUri is the app's stamp in Shopify's
  // inventory history (audit trail). `available` recomputes from on_hand.
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
