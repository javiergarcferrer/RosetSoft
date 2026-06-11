// Client helpers for the app's two Shopify connections.
//
// TWO stores, one connection each (shopify_config rows keyed by store):
//   • 'alcover'         — alcover.do: the inventory mirror the sync PUBLISHES
//     in-stock items to (and archives sold-out ones from).
//   • 'lifestylegarden' — lifestylegarden.do: the brand catalog the import
//     PULLS into `products`.
// Auth is the Dev Dashboard app flow ONLY: the app saves each store's Client
// ID + Client secret through a SECURITY DEFINER RPC (write-only — the browser
// never reads them back); the `shopify-sync` Edge Function mints and caches
// the short-lived tokens server-side (client credentials grant). Only the
// non-sensitive domain + connected-at land on `settings` for the UI.

import { supabase } from '../db/supabaseClient.js';
import { updateSettings } from '../db/database.js';

const TEAM_PROFILE_ID = 'team';

export const SHOPIFY_STORE_ALCOVER = 'alcover';
export const SHOPIFY_STORE_LSG = 'lifestylegarden';

/**
 * Save (or replace) one store's Shopify connection: the Dev Dashboard app's
 * `clientId` + `clientSecret` (its Settings page). The Edge Function exchanges
 * them for short-lived tokens (client credentials grant) and owns the token
 * cache — the client never sees a token. Credentials go to the write-only
 * shopify_config table via `save_shopify_config`; domain + connected-at land
 * on that store's settings mirror so the UI can show "connected" without ever
 * reading the secret back. One Dev Dashboard app installed on both stores can
 * serve both connections (same credentials, different domain).
 */
export async function saveShopifyConfig({ domain, clientId, clientSecret, store = SHOPIFY_STORE_ALCOVER, profileId = TEAM_PROFILE_ID }) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!d) throw new Error('Ingresa el dominio .myshopify.com de tu tienda (Shopify → Configuración → Dominios).');
  // The Admin API only answers on the canonical *.myshopify.com host — a
  // public/custom domain (alcover.do) or a misremembered store name is the
  // usual wrong paste, and it surfaces later as a misleading "token inválido".
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) {
    throw new Error('Ese no es un dominio .myshopify.com. Cópialo exacto de Shopify → Configuración → Dominios (p. ej. alcoversdq.myshopify.com — no tu dominio público alcover.do / lifestylegarden.do).');
  }
  const cid = String(clientId || '').trim();
  const csec = String(clientSecret || '').trim();
  if (!cid || !csec) {
    throw new Error('Ingresa el Client ID y el Client secret de la app (Dev Dashboard → tu app → Settings).');
  }
  // A pasted shpat_/shpss_ value means the user grabbed a TOKEN, not the
  // client credentials — catch the mix-up here instead of as an OAuth error.
  if (/^shp(at|ca|ss|ck)_/.test(csec)) {
    throw new Error('Eso parece un token (shp…_), no el Client secret. Copia el Client secret de la página Settings de tu app en el Dev Dashboard.');
  }
  const { error } = await supabase.rpc('save_shopify_config', {
    p_domain: d, p_store: store, p_client_id: cid, p_client_secret: csec,
  });
  if (error) throw new Error(error.message || 'No se pudo guardar la conexión con Shopify.');
  await updateSettings(profileId, store === SHOPIFY_STORE_LSG
    ? { shopifyLsgDomain: d, shopifyLsgConnectedAt: Date.now() }
    : { shopifyDomain: d, shopifyConnectedAt: Date.now() });
}

/**
 * Invoke the `shopify-sync` Edge Function and return its JSON body.
 *
 * The function answers a non-2xx (e.g. 502 on an auth/scope problem) with a
 * JSON body that carries the real reason. supabase-js surfaces that as a
 * generic "Edge Function returned a non-2xx status code" and tucks the Response
 * away on `error.context` — so we read the body back to recover the actual
 * message instead of the opaque one. Throws only on a true transport failure
 * (the function never answered).
 */
async function invokeShopify(body) {
  const { data, error } = await supabase.functions.invoke('shopify-sync', { body });
  if (!error) return data;
  const ctx = error.context;
  if (ctx && typeof ctx.json === 'function') {
    try { return await ctx.json(); } catch { /* not a JSON body — fall through */ }
  }
  throw new Error(error.message || 'No se pudo contactar con Shopify.');
}

/**
 * Push inventory to Shopify. Pass specific item ids to sync just those (e.g.
 * after a liquidation or a sale), or omit to reconcile the whole catalog.
 * Returns the function's summary ({ synced, archived, skipped, errors } or
 * { configured:false } / { error }). Safe to call fire-and-forget from
 * accounting flows (`.catch(() => {})`).
 */
export async function syncShopify(itemIds) {
  const body = Array.isArray(itemIds) && itemIds.length ? { itemIds } : {};
  return invokeShopify(body);
}

/**
 * Pull the LifestyleGarden catalog (the store's ACTIVE products — what
 * lifestylegarden.do shows) into `products`, brand 'lifestylegarden'. Returns
 * the function's summary ({ ok, products, skus, removed } or
 * { configured:false } / { ok:false, error }).
 */
export async function importLifestyleGardenCatalog() {
  return invokeShopify({ importCatalog: true });
}

/**
 * Verify one store's saved connection: does the token reach the store, and was
 * the custom app granted every scope that store's direction needs? Returns
 * { configured:false } when no token is saved, { ok:true, shop, missingScopes }
 * when reachable, or { ok:false, error } when Shopify rejects the token.
 */
export async function pingShopify(store = SHOPIFY_STORE_ALCOVER) {
  return invokeShopify({ test: true, store });
}
