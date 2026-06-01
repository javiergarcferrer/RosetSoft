// Client helpers for the public, no-login storefront ("Tienda").
//
// The dealer designates the house-account customer through the normal authed db
// (settings.storeCustomerId); these helpers are what the LOGGED-OUT storefront
// page uses to talk to the public `store` Edge Function, plus the URL builder.

const VITE_ENV =
  (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/** The public storefront URL. HashRouter, so `/#/tienda` — shareable as-is. */
export function storeLinkUrl() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/#/tienda`;
}

// The function endpoint, with the public anon key as a query param (not a
// header) so the request stays gateway-acceptable without forcing a custom
// header. The anon key is already public in the bundle.
function endpoint() {
  const base = `${SUPABASE_URL}/functions/v1/store`;
  return SUPABASE_ANON_KEY ? `${base}?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/**
 * Fetch the public store catalog. Returns the bundle the storefront renders:
 *   { configured, storeName, logoImageId, rates, quotes[], lines[], orders[] }
 * Throws on a network / server error so the page can show its error state.
 */
export async function fetchStoreCatalog() {
  const r = await fetch(endpoint());
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}
