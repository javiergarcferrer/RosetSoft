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
            collections(first: 10) { nodes { title } }
            variants(first: 100) {
              nodes { id title sku price inventoryItem { unitCost { amount } } }
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

  return {
    ok: errors.length === 0,
    products: summary.products,
    skus: rows.length,
    removed,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
}
