// Client helpers for the inventory → Shopify catalog sync.
//
// The store catalog mirrors in-stock inventory. The app saves the Shopify Admin
// token through a SECURITY DEFINER RPC (write-only — the browser never reads it
// back) and triggers the `shopify-sync` Edge Function, which publishes in-stock
// items and archives sold-out ones. The token stays server-side; only the
// non-sensitive domain + connected-at land on `settings` for the UI.

import { supabase } from '../db/supabaseClient.js';
import { updateSettings } from '../db/database.js';

const TEAM_PROFILE_ID = 'team';

/**
 * Save (or replace) the Shopify connection. The token goes to the write-only
 * shopify_config table via `save_shopify_config`; domain + connected-at land on
 * settings so the UI can show "connected" without ever reading the token back.
 */
export async function saveShopifyConfig({ domain, token, profileId = TEAM_PROFILE_ID }) {
  const d = String(domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!d) throw new Error('Ingresa el dominio de tu tienda (ej. alcover.myshopify.com).');
  if (!token || !token.trim()) throw new Error('Ingresa el Admin API access token (shpat_…).');
  const { error } = await supabase.rpc('save_shopify_config', { p_domain: d, p_token: token.trim() });
  if (error) throw new Error(error.message || 'No se pudo guardar la conexión con Shopify.');
  await updateSettings(profileId, { shopifyDomain: d, shopifyConnectedAt: Date.now() });
}

/**
 * Push inventory to Shopify. Pass specific item ids to sync just those (e.g.
 * after a liquidation or a sale), or omit to reconcile the whole catalog.
 * Returns the function's summary; throws only on a transport error. Safe to
 * call fire-and-forget from accounting flows (`.catch(() => {})`).
 */
export async function syncShopify(itemIds) {
  const body = Array.isArray(itemIds) && itemIds.length ? { itemIds } : {};
  const { data, error } = await supabase.functions.invoke('shopify-sync', { body });
  if (error) throw new Error(error.message || 'No se pudo sincronizar con Shopify.');
  return data;
}
