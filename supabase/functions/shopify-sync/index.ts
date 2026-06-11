// shopify-sync — the app's two-way bridge to the team's TWO Shopify stores.
//
// Connections live in shopify_config, ONE PER STORE (keyed profile_id+store):
//   • store 'alcover' (alcover.do = alcoversdq.myshopify.com) — the inventory
//     mirror. The default mode PUBLISHES in-stock pieces there.
//   • store 'lifestylegarden' (lifestylegarden.do = alcoversrl.myshopify.com)
//     — the brand catalog. importCatalog PULLS its active products into
//     `products`, brand 'lifestylegarden'.
//
// Inventory mirror (default mode, alcover store): the store catalog =
// in-stock pieces. For each inventory item this function:
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
// The app calls this (authed) after inventory changes — a liquidation lands
// stock, a sale empties it, an item's price/photo is edited — plus a manual
// "Sincronizar". Auth: each store's Dev Dashboard app credentials (client
// credentials grant; 24h tokens cached on the config row) are read from the
// write-only shopify_config table via the service role; nothing secret ever
// reaches the browser.
//
// Mapping mirrors src/lib/inventoryShopify.ts (the Deno↔Vite wall means we
// can't import it; the rule is trivial and kept equivalent on purpose).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { mapShopifyCatalog, LSG_BRAND, type ShopifyCatalogProduct } from './catalogImport.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Latest stable Admin API version (2026-04 GA'd April 2026).
const API_VERSION = '2026-04';
const TEAM = 'team';
const COLLECTION_TITLE = 'Ligne Roset Inventory';
const COLLECTION_HANDLE = 'ligne-roset-inventory';

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

  // The anon key passes the gateway's verify_jwt (it's a valid JWT) — require
  // a real signed-in team member before touching the Shopify Admin token.
  const authClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
  });
  const { data: auth } = await authClient.auth.getUser();
  if (!auth?.user) return json({ error: 'No autorizado.' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: { itemIds?: string[]; test?: boolean; importCatalog?: boolean; store?: string } = {};
  try { body = await req.json(); } catch { /* empty body = sync all */ }
  const itemIds = Array.isArray(body?.itemIds) ? body.itemIds : null;

  // Which store this call talks to: the catalog import reads the
  // LifestyleGarden store; everything else (inventory publish) writes the
  // Alcover store. `test` checks whichever store the caller names.
  const store = body?.importCatalog === true || body?.store === 'lifestylegarden'
    ? 'lifestylegarden'
    : 'alcover';

  // That store's connection (write-only table; service role reads). Auth is
  // the Dev Dashboard app's client credentials grant — per shopify.dev, the
  // minted token lives 24h and should be CACHED and refreshed before expiry
  // (and on a 401, e.g. after a secret rotation). The cache is the row's own
  // access_token/token_expires_at, written only here.
  const { data: cfg } = await admin
    .from('shopify_config').select('domain, access_token, token_expires_at, client_id, client_secret')
    .eq('profile_id', TEAM).eq('store', store).maybeSingle();
  const c = cfg as { domain?: string; access_token?: string | null; token_expires_at?: string | null; client_id?: string; client_secret?: string } | null;
  const domain = c?.domain;
  if (!domain || !c?.client_id || !c?.client_secret) {
    return json({ configured: false, store, message: 'Shopify no conectado' });
  }

  // Refresh ahead of the deadline so a token can't die mid-sync.
  const EXPIRY_SKEW_MS = 5 * 60 * 1000;
  const cacheValid = !!c.access_token && !!c.token_expires_at &&
    Date.parse(c.token_expires_at) - Date.now() > EXPIRY_SKEW_MS;
  let token = cacheValid ? (c.access_token as string) : '';

  /** Mint a fresh 24h token (client credentials grant) and persist it as the
   *  row's cache (best-effort — a failed cache write only costs a re-mint). */
  async function mintToken(): Promise<string> {
    const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c!.client_id as string,
        client_secret: c!.client_secret as string,
      }),
    });
    const grant = await r.json().catch(() => null) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
    if (!r.ok || !grant?.access_token) {
      // shop_not_permitted is the classic trip-up: the app and the store must
      // sit in the SAME Dev Dashboard organization, and the app must be
      // installed on the store.
      const reason = grant?.error_description || grant?.error || `HTTP ${r.status}`;
      throw new Error(`Shopify rechazó las credenciales de la app para ${domain}: ${reason}. Verifica que la app del Dev Dashboard esté en la MISMA organización que la tienda y que esté instalada en ella.`);
    }
    const expiresAt = new Date(Date.now() + (Number(grant.expires_in) || 86399) * 1000).toISOString();
    await admin.from('shopify_config')
      .update({ access_token: grant.access_token, token_expires_at: expiresAt })
      .eq('profile_id', TEAM).eq('store', store);
    return grant.access_token;
  }

  if (!token) {
    try { token = await mintToken(); } catch (e) {
      return json({ configured: true, ok: false, store, error: (e as Error).message }, 502);
    }
  }

  // GraphQL call that turns the classic setup mistakes into their OWN
  // messages instead of a generic "invalid token": a wrong domain (the store
  // answers 404/HTML) vs rejected auth (401/403 on the right store). A 401/403
  // on a CACHED token gets ONE re-mint + retry — the cache may simply be a
  // token revoked by a secret rotation.
  async function gql<T = any>(query: string, variables: Record<string, unknown> = {}, retried = false): Promise<T> {
    const r = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token as string },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 401 || r.status === 403) {
      await r.body?.cancel();
      if (!retried) {
        token = await mintToken(); // throws the descriptive credential error
        return gql(query, variables, true);
      }
      throw new Error(`la app no tiene acceso a ${domain} (HTTP ${r.status}). Revisa los permisos (scopes) de la app del Dev Dashboard y que esté instalada en ESA tienda.`);
    }
    if (r.status === 404) {
      await r.body?.cancel();
      throw new Error(`no existe una tienda Shopify en ${domain}. Usa el dominio .myshopify.com exacto (Shopify → Configuración → Dominios).`);
    }
    let b: { errors?: unknown; data?: T };
    try { b = await r.json(); } catch {
      throw new Error(`respuesta inesperada de ${domain} (HTTP ${r.status}) — ¿es el dominio .myshopify.com correcto?`);
    }
    if (b.errors) throw new Error(JSON.stringify(b.errors));
    return b.data as T;
  }

  // Connection check — verify the credentials reach the store and that the
  // app was granted every scope that store's direction needs (the catalog
  // import only READS; the inventory mirror also writes). The Settings screen
  // calls this right after saving so a bad/under-scoped credential is caught
  // at connect time (not silently as "0 published" later).
  if (body?.test === true) {
    const REQUIRED = store === 'lifestylegarden'
      ? ['read_products', 'read_inventory']
      : [
        'read_products', 'write_products', 'read_locations',
        'read_inventory', 'write_inventory',
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

  // Catalog import — the REVERSE direction: pull the store's LifestyleGarden
  // catalog (active products = what lifestylegarden.do shows) into `products`,
  // brand 'lifestylegarden'. The mapping lives in catalogImport.ts (pure,
  // pinned by tests/lsgCatalog.test.js); this branch fetches, upserts, then
  // sweeps LSG rows the import didn't touch (left the store) by updated_at.
  if (body?.importCatalog === true) {
    const syncStartIso = new Date().toISOString();
    try {
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

      const { rows, summary } = mapShopifyCatalog(products, {
        profileId: TEAM,
        nowIso: new Date().toISOString(),
      });
      const errors: string[] = [];
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await admin.from('products').upsert(rows.slice(i, i + 200));
        if (error) errors.push(error.message);
      }
      // Stale sweep only when every chunk landed — a partial import must not
      // delete rows whose refresh merely failed.
      let removed = 0;
      if (!errors.length) {
        const { data: stale } = await admin
          .from('products')
          .delete()
          .eq('profile_id', TEAM)
          .eq('brand', LSG_BRAND)
          .lt('updated_at', syncStartIso)
          .select('id');
        removed = stale?.length ?? 0;
      }
      return json({
        configured: true,
        ok: errors.length === 0,
        products: summary.products,
        skus: rows.length,
        removed,
        ...(errors.length ? { error: errors.join('; ') } : {}),
      }, errors.length ? 502 : 200);
    } catch (e) {
      return json({ configured: true, ok: false, error: `No se pudo importar el catálogo: ${(e as Error).message}` }, 502);
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

  // Resolve the location + the "Ligne Roset Inventory" collection once.
  // Synced products are grouped there (created as a manual collection if it
  // doesn't exist yet) instead of being published to the Online Store.
  let locationId: string | null = null;
  let collectionId: string | null = null;
  try {
    locationId = (await gql<{ locations: { nodes: { id: string }[] } }>(`{ locations(first: 1) { nodes { id } } }`)).locations.nodes[0]?.id ?? null;
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
