// shopify-sync — the app's bridge to the team's TWO Shopify stores.
//
// DATA FLOW (one direction per store; the third "store", /#/tienda, is the
// app's own public storefront and never touches Shopify):
//
//   inventory_items ──PUSH (default mode)──▶ 'alcover' store (alcover.do)
//                                            admin-only "Ligne Roset Inventory"
//   products(brand=lifestylegarden) ◀──PULL (importCatalog)── 'lifestylegarden'
//                                            store (lifestylegarden.do)
//
// MODES (POST body): { test, store? } → connection + scope check ·
// { importCatalog } → catalog pull · { itemIds? } → inventory mirror (the
// default; empty body reconciles everything). Mode→store routing is pure
// (stores.ts, pinned by tests/shopifySync.test.js).
//
// MODULES: stores.ts (pure rules: routing, scopes, token-cache validity,
// grant parsing, the shared inv-handle) · client.ts (per-store connection +
// authenticated gql; Dev Dashboard client-credentials grant with the 24h
// token cached on the config row) · catalogPull.ts (mapping I/O around the
// pure catalogImport.ts) · inventoryMirror.ts (the publish loop; decision
// mirrors src/lib/inventoryShopify.ts across the Deno↔Vite wall).
//
// Secrets: shopify_config is write-only (SECURITY DEFINER writer, service-role
// reader); nothing secret ever reaches the browser.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { storeForRequest, requiredScopes, STORE_LSG, type SyncRequest } from './stores.ts';
import { connectShopify } from './client.ts';
import { pullCatalog } from './catalogPull.ts';
import { mirrorInventory } from './inventoryMirror.ts';
import { adjustLsgInventory } from './lsgInventory.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const TEAM = 'team';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: SyncRequest = {};
  try { body = await req.json(); } catch { /* empty body = sync all */ }

  // ── ensureCron: (re)register the LSG stock-refresh cron. Admin-gated; the
  // function knows its own URL + service key from its env, so no project URL is
  // ever hardcoded. The LSG Settings/Catalog screens call it once on connect. ──
  if (body?.ensureCron === true) {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return json({ ok: false, error: 'Authorization requerida' }, 401);
    const caller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await caller.auth.getUser();
    if (!userData?.user) return json({ ok: false, error: 'Sesión inválida' }, 401);
    const { data: prof } = await caller.from('profiles').select('role, active').eq('id', userData.user.id).maybeSingle();
    if (!prof || prof.role !== 'admin' || !prof.active) return json({ ok: false, error: 'Solo un administrador.' }, 403);
    const fnUrl = `${SUPABASE_URL}/functions/v1/shopify-sync`;
    const { error } = await admin.rpc('ensure_shopify_refresh_cron', { p_url: fnUrl, p_secret: SERVICE_ROLE_KEY });
    if (error) return json({ ok: false, error: error.message });
    return json({ ok: true });
  }

  // ── cron refresh: only the cron job (Bearer service key) may run this. Re-pull
  // the LSG catalog so mirrored stock_qty reflects Shopify-side sales. ──────────
  if (body?.cron === true) {
    if ((req.headers.get('Authorization') || '') !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'forbidden' }, 403);
    const conn = await connectShopify(admin, TEAM, STORE_LSG);
    if (!conn.configured) return json({ cron: true, configured: false });
    try {
      const r = await pullCatalog(admin, TEAM, conn.gql);
      return json({ cron: true, ...r }, r.ok ? 200 : 502);
    } catch (e) {
      return json({ cron: true, ok: false, error: (e as Error).message }, 502);
    }
  }

  // The anon key passes the gateway's verify_jwt (it's a valid JWT) — require
  // a real signed-in team member before touching the Shopify credentials.
  const authClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
  });
  const { data: auth } = await authClient.auth.getUser();
  if (!auth?.user) return json({ error: 'No autorizado.' }, 401);

  // LSG inventory write-back — decrement the LifestyleGarden store when an LSG
  // product is sold inside ALCOVER (the PUSH half of the two-way sync). Hard-
  // wired to the LSG store regardless of the default routing.
  if (Array.isArray(body?.lsgAdjust) && body.lsgAdjust.length) {
    const conn = await connectShopify(admin, TEAM, STORE_LSG);
    if (!conn.configured) return json({ configured: false, store: STORE_LSG, message: 'Shopify no conectado' });
    try {
      const r = await adjustLsgInventory(conn.gql, body.lsgAdjust, {
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
        reference: typeof body.reference === 'string' ? body.reference : undefined,
      });
      return json({ configured: true, store: STORE_LSG, ...r }, r.ok ? 200 : 502);
    } catch (e) {
      return json({ configured: true, ok: false, store: STORE_LSG, error: `No se pudo ajustar el inventario LSG: ${(e as Error).message}` }, 502);
    }
  }

  const store = storeForRequest(body);
  const conn = await connectShopify(admin, TEAM, store);
  if (!conn.configured) return json({ configured: false, store, message: 'Shopify no conectado' });
  const { gql } = conn;

  // Connection check — does the credential reach the store, and was the app
  // granted every scope this store's direction needs? The Settings screen
  // calls this right after saving so a bad/under-scoped credential is caught
  // at connect time (not silently as "0 published" later).
  if (body?.test === true) {
    try {
      const shop = (await gql<{ shop: { name: string; myshopifyDomain: string } }>(
        `{ shop { name myshopifyDomain } }`,
      )).shop;
      // The token's OWN granted scopes (the mint response's `scope`), not
      // currentAppInstallation.accessScopes — the latter reports the
      // per-installation granted set, which lags the app's released config and
      // wrongly flags freshly-added write_inventory/read_locations as missing.
      const granted = await conn.verifyScopes();
      const missingScopes = requiredScopes(store).filter((s) => !granted.includes(s));
      return json({ configured: true, ok: true, store, shop: shop.name, domain: shop.myshopifyDomain, missingScopes });
    } catch (e) {
      return json({ configured: true, ok: false, store, error: (e as Error).message }, 502);
    }
  }

  // Catalog pull — LifestyleGarden store → products(brand=lifestylegarden).
  if (body?.importCatalog === true) {
    try {
      const r = await pullCatalog(admin, TEAM, gql);
      return json({ configured: true, store, ...r }, r.ok ? 200 : 502);
    } catch (e) {
      return json({ configured: true, ok: false, store, error: `No se pudo importar el catálogo: ${(e as Error).message}` }, 502);
    }
  }

  // Inventory mirror (default) — in-stock pieces → the Alcover store.
  try {
    const itemIds = Array.isArray(body?.itemIds) && body.itemIds.length ? body.itemIds : null;
    const r = await mirrorInventory(admin, TEAM, gql, { itemIds, supabaseUrl: SUPABASE_URL });
    return json({ configured: true, store, ...r });
  } catch (e) {
    return json({ configured: true, ok: false, store, error: `No se pudo sincronizar el inventario: ${(e as Error).message}` }, 502);
  }
});
