// Catalog PULL — LifestyleGarden store → `products` rows, brand
// 'lifestylegarden'. The mapping decisions live in catalogImport.ts (pure,
// pinned by tests/lsgCatalog.test.js); this module owns the I/O: page the
// store's ACTIVE products (what lifestylegarden.do shows), upsert the mapped
// rows, then sweep LSG rows the import didn't touch (products that left the
// store) by updated_at. The sweep is brand-scoped — it can never touch the
// Ligne Roset rows — and runs only when every chunk landed, so a partial
// import can't delete rows whose refresh merely failed.
//
// Photos are NEVER stored locally: every gallery url becomes an `images` row
// that POINTS at the Shopify CDN (external_url, no bytes in our bucket).
// Pointer ids are content-addressed from the url (lsgimg-<sha1>) — the same
// scheme the retired byte-mirror used — so quote lines that snapshotted a
// mirrored id keep resolving after the pointer pass overwrites that row.

import { mapShopifyCatalog, LSG_BRAND, type ShopifyCatalogProduct } from './catalogImport.ts';
import type { Gql } from './client.ts';

export interface CatalogPullResult {
  ok: boolean;
  products: number;
  skus: number;
  removed: number;
  /** Store photos linked (CDN pointers) after this run. */
  images: number;
  error?: string;
}

// deno-lint-ignore no-explicit-any
export async function pullCatalog(admin: any, team: string, gql: Gql): Promise<CatalogPullResult> {
  const syncStartIso = new Date().toISOString();

  // Page EVERY active product. We keep the PROVEN page sizes (products 50,
  // variants 100) so the calculated query cost stays where it works — raising
  // either multiplies the cost and risks MAX_COST rejection. Instead we lift the
  // PAGE-COUNT budget (with throttle backoff now in client.ts, more sequential
  // pages are cheap) and, crucially, track whether the read was COMPLETE.
  // `complete` flips true only when we exit on no-next-page; `variantTruncated`
  // flags any product with more than 100 variants (essentially never for
  // furniture). On an incomplete read the destructive stale-sweep below MUST NOT
  // run — deleting the unread tail makes it flap back on the next full sync.
  const MAX_PAGES = 400; // 400 × 50 = 20k SKUs of headroom
  const products: ShopifyCatalogProduct[] = [];
  let after: string | null = null;
  let complete = false;
  let variantTruncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await gql<{ products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ShopifyCatalogProduct[];
    } }>(
      `query($after: String) {
        products(first: 50, after: $after, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title handle productType status
            featuredMedia { preview { image { url } } }
            media(first: 10) { nodes { preview { image { url } } } }
            collections(first: 10) { nodes { title } }
            variants(first: 100) {
              pageInfo { hasNextPage }
              nodes {
                id title sku price inventoryQuantity
                media(first: 1) { nodes { preview { image { url } } } }
                inventoryItem { unitCost { amount } }
              }
            }
          }
        }
      }`,
      { after },
    );
    products.push(...r.products.nodes);
    if (r.products.nodes.some((n) => (n.variants as { pageInfo?: { hasNextPage?: boolean } } | null)?.pageInfo?.hasNextPage)) {
      variantTruncated = true;
    }
    if (!r.products.pageInfo.hasNextPage) { complete = true; break; }
    after = r.products.pageInfo.endCursor;
  }
  // Incomplete read (catalog beyond the page budget, or a >100-variant product)
  // → skip the delete sweep and report not-ok rather than silently lose rows.
  const fullRead = complete && !variantTruncated;

  const { rows, summary } = mapShopifyCatalog(products, { profileId: team, nowIso: new Date().toISOString() });

  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from('products').upsert(rows.slice(i, i + 200));
    if (error) errors.push(error.message);
  }

  let removed = 0;
  if (!errors.length && fullRead) {
    const { data: stale } = await admin
      .from('products')
      .delete()
      .eq('profile_id', team)
      .eq('brand', LSG_BRAND)
      .lt('updated_at', syncStartIso)
      .select('id');
    removed = stale?.length ?? 0;
  }

  // Link every gallery photo as a CDN pointer (quote lines snapshot the
  // pointer ids on insert, so client link / PDF render through the existing
  // images pipeline — without a single byte stored on our side). Best-effort:
  // a failed pass leaves image_id/extra_image_ids as they were and the UI
  // still shows the cover via image_src (ImageView's fallbackUrl).
  let images = 0;
  if (!errors.length) {
    try {
      images = await syncImagePointers(admin, team);
      await removeMirroredBytes(admin);
    } catch (_) { /* next sync retries */ }
  }

  // An incomplete read isn't a hard failure (the rows we DID fetch are upserted
  // and fresh), but it's not-ok so the caller can warn and re-run, and we never
  // claim a clean sweep we didn't do.
  const incompleteMsg = fullRead ? null
    : (variantTruncated
        ? 'Lectura incompleta: un producto tiene más de 100 variantes; no se eliminaron filas obsoletas.'
        : 'Lectura incompleta: el catálogo excede el límite de páginas; no se eliminaron filas obsoletas.');
  const allErrors = [...errors, ...(incompleteMsg ? [incompleteMsg] : [])];

  return {
    ok: errors.length === 0 && fullRead,
    products: summary.products,
    skus: rows.length,
    removed,
    images,
    ...(allErrors.length ? { error: allErrors.join('; ') } : {}),
  };
}

const IMG_KIND = 'catalog-lsg';
const IMG_BUCKET = 'images';
const WRITE_PARALLEL = 8;

/** Deterministic id for a store photo, from its source URL. */
async function imageIdFor(src: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(src));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `lsgimg-${hex.slice(0, 20)}`;
}

interface PointerProductRow {
  id: string;
  image_srcs: string[] | null;
  image_id: string | null;
  extra_image_ids: string[] | null;
}

/**
 * Ensure every LSG gallery url has an `images` POINTER row (external_url =
 * the CDN url, no stored bytes) and every product row points at its pointers:
 * `image_id` = the cover, `extra_image_ids` = the rest. Idempotent — ids are
 * content-addressed from the url, the upsert rewrites unchanged rows in
 * place, and product rows are only written when their pointers moved.
 * Pointers whose url left the catalog (photo replaced / product gone) are
 * deleted. Returns how many photos are linked.
 */
// deno-lint-ignore no-explicit-any
async function syncImagePointers(admin: any, team: string): Promise<number> {
  const { data: prods } = await admin
    .from('products').select('id, image_srcs, image_id, extra_image_ids')
    .eq('profile_id', team).eq('brand', LSG_BRAND);
  const rows = (prods ?? []) as PointerProductRow[];

  const wanted = new Map<string, string>(); // src url → pointer id
  for (const p of rows) {
    for (const src of p.image_srcs ?? []) {
      if (src && !wanted.has(src)) wanted.set(src, await imageIdFor(src));
    }
  }

  // Upsert the pointers. Writing storage_path/content_type/size as null also
  // converts any row the retired byte-mirror created (same id) into a pure
  // pointer, freeing its bytes for the storage sweep below.
  const pointers = [...wanted].map(([src, id]) => ({
    id, kind: IMG_KIND, owner_id: 'lsg-catalog', label: src,
    external_url: src, storage_path: null, content_type: null, size: null,
  }));
  for (let i = 0; i < pointers.length; i += 200) {
    const { error } = await admin.from('images').upsert(pointers.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }

  // Point each product row at its pointers (cover + extras), only on change.
  const stale = rows.filter((p) => {
    const ids = (p.image_srcs ?? []).map((s) => wanted.get(s)).filter(Boolean) as string[];
    const extras = ids.slice(1);
    const current = p.extra_image_ids ?? [];
    return (p.image_id ?? null) !== (ids[0] ?? null)
      || extras.length !== current.length
      || extras.some((id, i) => id !== current[i]);
  });
  for (let i = 0; i < stale.length; i += WRITE_PARALLEL) {
    await Promise.all(stale.slice(i, i + WRITE_PARALLEL).map((p) => {
      const ids = (p.image_srcs ?? []).map((s) => wanted.get(s)).filter(Boolean) as string[];
      return admin.from('products')
        .update({ image_id: ids[0] ?? null, extra_image_ids: ids.length > 1 ? ids.slice(1) : null })
        .eq('id', p.id).eq('profile_id', team);
    }));
  }

  // Orphan sweep: pointers whose source url no longer appears in the catalog.
  const { data: imgs } = await admin.from('images').select('id, label').eq('kind', IMG_KIND);
  const orphans = ((imgs ?? []) as Array<{ id: string; label: string }>)
    .filter((i) => !wanted.has(i.label)).map((i) => i.id);
  for (let i = 0; i < orphans.length; i += 200) {
    await admin.from('images').delete().in('id', orphans.slice(i, i + 200));
  }

  return wanted.size;
}

/**
 * Storage cleanup: the retired byte-mirror stored downscaled copies under
 * catalog-lsg/ in the images bucket. Pointers made those bytes dead weight —
 * sweep the folder until empty. Idempotent and cheap once clean (one empty
 * list call per sync).
 */
// deno-lint-ignore no-explicit-any
async function removeMirroredBytes(admin: any): Promise<void> {
  for (let page = 0; page < 30; page++) {
    const { data: objs } = await admin.storage.from(IMG_BUCKET).list('catalog-lsg', { limit: 100 });
    if (!objs?.length) return;
    const paths = (objs as Array<{ name: string }>).map((o) => `catalog-lsg/${o.name}`);
    const { error } = await admin.storage.from(IMG_BUCKET).remove(paths);
    if (error) return; // next sync retries
  }
}
