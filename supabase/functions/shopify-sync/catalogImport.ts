// LifestyleGarden catalog import — the PURE mapping from the team's Shopify
// store products (www.lifestylegarden.do, vendor Scancom International) to
// `products` rows, brand `lifestylegarden`.
//
// Kept free of Deno/Supabase imports so tests/lsgCatalog.test.js can pin it
// from Node (same pattern as quote-share/pick.ts). index.ts owns the fetching
// and the writes; this module owns every mapping decision:
//   • only ACTIVE products import — drafts are the out-of-assortment pool and
//     the public site doesn't show them.
//   • the inventory-mirror products this same function PUBLISHES (handle
//     `inv-…`, see stores.ts pieceHandle) must never feed back into the catalog.
//   • category/family come from the store's COLLECTIONS: LifestyleGarden
//     organizes by range (Garnet, Nassau, Panama Dark, …) and the range name is
//     written into each product title — so the longest collection title found
//     inside the title is the range. `productType` is empty store-wide today
//     but wins when present (it's Shopify's canonical type slot).
//   • one row per VARIANT (the priced unit), keyed `lsg-<variantId>` so a
//     re-import upserts in place. `reference` (unique per profile with the LR
//     SKUs) is the variant SKU; duplicates within one import keep the first.

export const LSG_BRAND = 'lifestylegarden';

export interface ShopifyMediaPreview {
  preview?: { image?: { url?: string | null } | null } | null;
}

export interface ShopifyCatalogVariant {
  id: string;
  title?: string | null;
  sku?: string | null;
  price?: string | number | null;
  /** The variant's own media (first node), when the store assigns one. */
  media?: { nodes?: ShopifyMediaPreview[] | null } | null;
  inventoryItem?: { unitCost?: { amount?: string | number | null } | null } | null;
}

export interface ShopifyCatalogProduct {
  id: string;
  title?: string | null;
  handle?: string | null;
  productType?: string | null;
  status?: string | null;
  featuredMedia?: ShopifyMediaPreview | null;
  collections?: { nodes?: Array<{ title?: string | null }> | null } | null;
  variants?: { nodes?: ShopifyCatalogVariant[] | null } | null;
}

/** A `products` row as written to Postgres (snake_case — index.ts writes via
 *  the service-role client, not the app's camelCase mapper). */
export interface LsgProductRow {
  id: string;
  profile_id: string;
  brand: string;
  reference: string;
  name: string;
  subtype: string;
  dimensions: string;
  family: string;
  family_code: string;
  category: string;
  price_usd: number | null;
  cost: number | null;
  /** The store's CDN photo URL — the variant's own image, else the product's
   *  featured one. index.ts mirrors it into our images bucket (`image_id` is
   *  set THERE, never here, so an upsert can't clobber an existing mirror). */
  image_src: string;
  active: boolean;
  updated_at: string;
}

export interface LsgImportSummary {
  products: number;        // active catalog products mapped
  skippedInventory: number; // inv-* mirror products excluded
  skippedInactive: number;  // non-ACTIVE products excluded
  duplicateRefs: number;    // variants dropped for a repeated reference
}

/** Collapse whitespace runs — the same normalization the LR CSV import applies
 *  (priceListCsv.squish), so search matches regardless of source spacing. */
const squish = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Numeric tail of a Shopify GID (gid://shopify/ProductVariant/123 → "123"). */
const gidTail = (gid: string): string => String(gid || '').split('/').pop() || '';

/**
 * The photo URL for a variant row: the variant's OWN media when the store
 * assigns one (multi-color products), else the product's featured media.
 * Empty when the product has no photo at all.
 */
export function imageSrcOf(
  p: Pick<ShopifyCatalogProduct, 'featuredMedia'>,
  v: Pick<ShopifyCatalogVariant, 'media'> | null | undefined,
): string {
  const variantUrl = v?.media?.nodes?.[0]?.preview?.image?.url;
  const productUrl = p?.featuredMedia?.preview?.image?.url;
  return squish(variantUrl || productUrl || '');
}

/**
 * The product's RANGE: the longest of its collection titles that appears
 * (case-insensitively) inside the product title — "Panama Dark Sofa…" matches
 * "Panama Dark" over "Panama". Empty when no collection name is in the title
 * (type-only collections like "Mesas" don't appear in titles).
 */
export function rangeOf(p: Pick<ShopifyCatalogProduct, 'title' | 'collections'>): string {
  const title = squish(p.title).toLowerCase();
  if (!title) return '';
  let best = '';
  for (const c of p.collections?.nodes || []) {
    const t = squish(c?.title);
    if (t && t.length > best.length && title.includes(t.toLowerCase())) best = t;
  }
  return best;
}

/**
 * Map the fetched Shopify products to catalog rows. Pure; `nowIso` stamps
 * `updated_at` so index.ts can delete LSG rows the import didn't touch
 * (products that left the store) with one `updated_at < syncStart` sweep.
 */
export function mapShopifyCatalog(
  products: ShopifyCatalogProduct[],
  ctx: { profileId: string; nowIso: string },
): { rows: LsgProductRow[]; summary: LsgImportSummary } {
  const rows: LsgProductRow[] = [];
  const seenRefs = new Set<string>();
  const summary: LsgImportSummary = { products: 0, skippedInventory: 0, skippedInactive: 0, duplicateRefs: 0 };

  for (const p of products || []) {
    if ((p.handle || '').startsWith('inv-')) { summary.skippedInventory++; continue; }
    if (squish(p.status).toUpperCase() !== 'ACTIVE') { summary.skippedInactive++; continue; }

    const title = squish(p.title);
    const range = rangeOf(p);
    const firstCollection = squish(p.collections?.nodes?.[0]?.title);
    const category = range || squish(p.productType) || firstCollection;
    summary.products++;

    for (const v of p.variants?.nodes || []) {
      const vid = gidTail(v.id);
      if (!vid) continue;
      const variantTitle = squish(v.title);
      const isDefault = /^default title$/i.test(variantTitle);
      const reference = squish(v.sku) || `LSG-${vid}`;
      if (seenRefs.has(reference)) { summary.duplicateRefs++; continue; }
      seenRefs.add(reference);
      rows.push({
        id: `lsg-${vid}`,
        profile_id: ctx.profileId,
        brand: LSG_BRAND,
        reference,
        // The variant axis (color/size) is part of what the dealer quotes, so a
        // real variant title joins the name; the subtype slot carries it alone
        // (the catalog "Description 2", shown as productDescription on lines).
        name: isDefault || !variantTitle ? title : `${title} · ${variantTitle}`,
        subtype: isDefault ? '' : variantTitle,
        dimensions: '',
        family: range,
        family_code: squish(p.handle),
        category,
        price_usd: numOrNull(v.price),
        cost: numOrNull(v.inventoryItem?.unitCost?.amount),
        image_src: imageSrcOf(p, v),
        active: true,
        updated_at: ctx.nowIso,
      });
    }
  }
  return { rows, summary };
}
