// shopify-sync — mirror IN-STOCK inventory into the Shopify catalog.
//
// The store catalog = in-stock pieces. For each inventory item this function:
//   • in stock (qty > 0) AND priced (selling_price > 0) → upsert an ACTIVE
//     Shopify product (one listing per item, keyed by the stable handle
//     inv-<id>), set its price, on-hand quantity and photo, and publish it to
//     the Online Store.
//   • otherwise, if it was previously published → ARCHIVE it (leaves the
//     catalog). Catalog stays "in-stock only".
//
// The app calls this (authed) after inventory changes — a liquidation lands
// stock, a sale empties it, an item's price/photo is edited — plus a manual
// "Sincronizar". The Shopify Admin token is read from the write-only
// shopify_config table via the service role; it never reaches the browser.
//
// Mapping mirrors src/lib/inventoryShopify.ts (the Deno↔Vite wall means we
// can't import it; the rule is trivial and kept equivalent on purpose).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const API_VERSION = '2024-10';
const TEAM = 'team';

/** Stable Shopify handle for an inventory item (mirrors inventoryShopify.ts). */
function pieceHandle(id: string): string {
  const slug = String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `inv-${slug || 'item'}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // Shopify credentials (write-only table; service role reads).
  const { data: cfg } = await admin
    .from('shopify_config').select('domain, access_token').eq('profile_id', TEAM).maybeSingle();
  const domain = (cfg as { domain?: string } | null)?.domain;
  const token = (cfg as { access_token?: string } | null)?.access_token;
  if (!domain || !token) return json({ configured: false, message: 'Shopify no conectado' });

  async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token as string },
      body: JSON.stringify({ query, variables }),
    });
    const b = await r.json();
    if (b.errors) throw new Error(JSON.stringify(b.errors));
    return b.data as T;
  }

  let body: { itemIds?: string[]; test?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body = sync all */ }
  const itemIds = Array.isArray(body?.itemIds) ? body.itemIds : null;

  // Connection check — verify the token reaches the store and that the custom
  // app was granted every scope the sync needs. The Settings screen calls this
  // right after saving a token so a bad/under-scoped credential is caught at
  // connect time (not silently as "0 published" later).
  if (body?.test === true) {
    const REQUIRED = [
      'read_products', 'write_products', 'read_locations',
      'read_publications', 'write_publications', 'read_inventory', 'write_inventory',
    ];
    try {
      const shop = (await gql<{ shop: { name: string; myshopifyDomain: string } }>(
        `{ shop { name myshopifyDomain } }`,
      )).shop;
      const granted = (await gql<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(
        `{ currentAppInstallation { accessScopes { handle } } }`,
      )).currentAppInstallation.accessScopes.map((s) => s.handle);
      const missingScopes = REQUIRED.filter((s) => !granted.includes(s));
      return json({ configured: true, ok: true, shop: shop.name, domain: shop.myshopifyDomain, missingScopes });
    } catch (e) {
      return json({ configured: true, ok: false, error: `Shopify rechazó el token: ${(e as Error).message}` }, 502);
    }
  }

  // Items to reconcile: the requested ones, else everything that is either
  // already linked (so sold ones get archived) or priced (so it can publish).
  let q = admin.from('inventory_items')
    .select('id, sku, name, qty_on_hand, selling_price, image_id, shopify_product_id')
    .eq('profile_id', TEAM);
  q = itemIds ? q.in('id', itemIds) : q.or('shopify_product_id.not.is.null,selling_price.gt.0');
  const { data: items } = await q;
  if (!items?.length) return json({ configured: true, synced: 0, archived: 0, skipped: 0 });

  // Resolve the location + Online Store publication once.
  let locationId: string | null = null;
  let onlineStoreId: string | null = null;
  try {
    locationId = (await gql<{ locations: { nodes: { id: string }[] } }>(`{ locations(first: 1) { nodes { id } } }`)).locations.nodes[0]?.id ?? null;
    const pubs = (await gql<{ publications: { nodes: { id: string; title: string }[] } }>(`{ publications(first: 20) { nodes { id title } } }`)).publications.nodes;
    onlineStoreId = pubs.find((p) => /online store/i.test(p.title))?.id ?? null;
  } catch (e) {
    return json({ configured: true, error: `Shopify auth/scope error: ${(e as Error).message}` }, 502);
  }

  const out = { configured: true, synced: 0, archived: 0, skipped: 0, errors: [] as string[] };

  for (const it of items as Row[]) {
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
          if (p) imageUrl = `${SUPABASE_URL}/storage/v1/object/public/images/${p}`;
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

        // On-hand quantity (best-effort — a quantity hiccup must not block listing).
        if (invItemId && locationId) {
          try {
            await gql(
              `mutation($input: InventorySetQuantitiesInput!) {
                inventorySetQuantities(input: $input) { userErrors { field message } }
              }`,
              { input: { name: 'available', reason: 'correction', ignoreCompareQuantity: true,
                quantities: [{ inventoryItemId: invItemId, locationId, quantity: Math.floor(qty) }] } },
            );
          } catch (_) { /* leave qty for a later sync */ }
        }

        // Publish to the Online Store so it's live in the catalog.
        if (onlineStoreId) {
          await gql(
            `mutation($id: ID!, $pubs: [PublicationInput!]!) {
              publishablePublish(id: $id, input: $pubs) { userErrors { field message } }
            }`,
            { id: pid, pubs: [{ publicationId: onlineStoreId }] },
          );
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

  return json(out);
});

type Row = {
  id: string;
  sku: string | null;
  name: string | null;
  qty_on_hand: number | null;
  selling_price: number | null;
  image_id: string | null;
  shopify_product_id: string | null;
};
