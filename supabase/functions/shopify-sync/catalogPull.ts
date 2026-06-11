// Catalog PULL — LifestyleGarden store → `products` rows, brand
// 'lifestylegarden'. The mapping decisions live in catalogImport.ts (pure,
// pinned by tests/lsgCatalog.test.js); this module owns the I/O: page the
// store's ACTIVE products (what lifestylegarden.do shows), upsert the mapped
// rows, then sweep LSG rows the import didn't touch (products that left the
// store) by updated_at. The sweep is brand-scoped — it can never touch the
// Ligne Roset rows — and runs only when every chunk landed, so a partial
// import can't delete rows whose refresh merely failed.

import { mapShopifyCatalog, LSG_BRAND, type ShopifyCatalogProduct } from './catalogImport.ts';
import type { Gql } from './client.ts';

export interface CatalogPullResult {
  ok: boolean;
  products: number;
  skus: number;
  removed: number;
  /** Photos newly mirrored into the images bucket this run. */
  images: number;
  error?: string;
}

// deno-lint-ignore no-explicit-any
export async function pullCatalog(admin: any, team: string, gql: Gql): Promise<CatalogPullResult> {
  const syncStartIso = new Date().toISOString();

  const products: ShopifyCatalogProduct[] = [];
  let after: string | null = null;
  for (let page = 0; page < 60; page++) {
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
            collections(first: 10) { nodes { title } }
            variants(first: 100) {
              nodes {
                id title sku price
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
    if (!r.products.pageInfo.hasNextPage) break;
    after = r.products.pageInfo.endCursor;
  }

  const { rows, summary } = mapShopifyCatalog(products, { profileId: team, nowIso: new Date().toISOString() });

  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from('products').upsert(rows.slice(i, i + 200));
    if (error) errors.push(error.message);
  }

  let removed = 0;
  if (!errors.length) {
    const { data: stale } = await admin
      .from('products')
      .delete()
      .eq('profile_id', team)
      .eq('brand', LSG_BRAND)
      .lt('updated_at', syncStartIso)
      .select('id');
    removed = stale?.length ?? 0;
  }

  // Mirror the store photos into our own bucket (quote lines snapshot the
  // mirrored image_id, so the client link / PDF render through the existing
  // pipeline). Best-effort: a failed mirror leaves image_id null and the UI
  // still shows the photo via image_src (ImageView's fallbackUrl).
  let images = 0;
  if (!errors.length) {
    try { images = await mirrorCatalogImages(admin, team); } catch (_) { /* next sync retries */ }
  }

  return {
    ok: errors.length === 0,
    products: summary.products,
    skus: rows.length,
    removed,
    images,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
}

const IMG_KIND = 'catalog-lsg';
const IMG_BUCKET = 'images';
const MIRRORS_PER_RUN = 300;   // safety cap; a huge first import finishes over a couple of syncs
const MIRROR_PARALLEL = 6;

/** Deterministic id for a mirrored photo, from its source URL. */
async function imageIdFor(src: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(src));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `lsgimg-${hex.slice(0, 20)}`;
}

/**
 * Ensure every LSG product's `image_src` has a mirrored copy in the images
 * bucket and its row points at it. Idempotent: the images row's `label` IS the
 * source URL, so an unchanged photo is never re-downloaded and a changed one
 * gets a fresh mirror; orphaned mirrors (photo replaced / product gone) are
 * cleaned up. Returns how many photos were newly mirrored.
 */
// deno-lint-ignore no-explicit-any
async function mirrorCatalogImages(admin: any, team: string): Promise<number> {
  const { data: prods } = await admin
    .from('products').select('id, image_src, image_id')
    .eq('profile_id', team).eq('brand', LSG_BRAND).neq('image_src', '');
  const wanted = new Map<string, string[]>(); // src → product row ids
  for (const p of (prods ?? []) as Array<{ id: string; image_src: string; image_id: string | null }>) {
    const list = wanted.get(p.image_src);
    if (list) list.push(p.id);
    else wanted.set(p.image_src, [p.id]);
  }

  const { data: imgs } = await admin
    .from('images').select('id, label').eq('kind', IMG_KIND);
  const mirrored = new Map<string, string>(); // src (label) → images.id
  for (const i of (imgs ?? []) as Array<{ id: string; label: string }>) mirrored.set(i.label, i.id);

  // Download + store the missing ones, a few at a time.
  const missing = [...wanted.keys()].filter((src) => !mirrored.has(src)).slice(0, MIRRORS_PER_RUN);
  let added = 0;
  for (let i = 0; i < missing.length; i += MIRROR_PARALLEL) {
    await Promise.all(missing.slice(i, i + MIRROR_PARALLEL).map(async (src) => {
      try {
        // Shopify's CDN resizes on demand — 900px is plenty for cards/PDF.
        const r = await fetch(src + (src.includes('?') ? '&' : '?') + 'width=900');
        if (!r.ok) { await r.body?.cancel(); return; }
        const bytes = new Uint8Array(await r.arrayBuffer());
        const contentType = r.headers.get('content-type') || 'image/jpeg';
        const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
        const id = await imageIdFor(src);
        const storagePath = `catalog-lsg/${id}.${ext}`;
        const up = await admin.storage.from(IMG_BUCKET).upload(storagePath, bytes, { contentType, upsert: true });
        if (up.error) return;
        const ins = await admin.from('images').upsert({
          id, kind: IMG_KIND, owner_id: 'lsg-catalog', label: src,
          content_type: contentType, size: bytes.byteLength, storage_path: storagePath,
        });
        if (!ins.error) { mirrored.set(src, id); added++; }
      } catch (_) { /* skip this photo; next sync retries */ }
    }));
  }

  // Point the product rows at their mirrors (only the rows that don't already).
  for (const src of wanted.keys()) {
    const imageId = mirrored.get(src);
    if (!imageId) continue;
    const stale = ((prods ?? []) as Array<{ id: string; image_src: string; image_id: string | null }>)
      .filter((p) => p.image_src === src && p.image_id !== imageId)
      .map((p) => p.id);
    if (stale.length) {
      await admin.from('products').update({ image_id: imageId }).in('id', stale).eq('profile_id', team);
    }
  }

  // Orphan sweep: mirrors whose source URL no longer appears in the catalog
  // (photo replaced upstream, or the product left the store).
  const orphans = ((imgs ?? []) as Array<{ id: string; label: string }>).filter((i) => !wanted.has(i.label));
  if (orphans.length) {
    const { data: rowsToDrop } = await admin
      .from('images').select('id, storage_path').in('id', orphans.map((o) => o.id));
    const paths = ((rowsToDrop ?? []) as Array<{ storage_path?: string }>).map((r) => r.storage_path).filter(Boolean);
    if (paths.length) await admin.storage.from(IMG_BUCKET).remove(paths);
    await admin.from('images').delete().in('id', orphans.map((o) => o.id));
  }

  return added;
}
