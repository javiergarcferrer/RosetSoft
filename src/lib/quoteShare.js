// Client helpers for the public, interactive quote share link.
//
// The dealer side writes `shareToken`/`shareEnabled` on the quote through the
// normal authed db; these helpers are what the (logged-out) viewer uses to
// talk to the `quote-share` Edge Function, plus the URL builder + token mint.

const VITE_ENV =
  (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/**
 * The shareable URL a dealer hands a client. HashRouter, so `/#/q/<token>`.
 *
 * An optional `slug` (the "client-name-cotizacion-N" string from
 * lib/quoteNaming) is inserted BEFORE the token so the link a dealer sends
 * reads like the PDF it matches — `/#/q/eduardo-garcia-cotizacion-1042/<token>`
 * — instead of an opaque token alone. The token stays the real key (the route
 * ignores the slug), so links minted before this, or with no slug, still work.
 */
export function shareLinkUrl(token, slug) {
  if (!token) return '';
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const path = slug
    ? `${encodeURIComponent(slug)}/${encodeURIComponent(token)}`
    : encodeURIComponent(token);
  return `${origin}/#/q/${path}`;
}

// The function endpoint, with the public anon key as a query param (not a
// header) so the request stays gateway-acceptable without forcing a custom
// header on every call. The anon key is already public in the bundle.
function endpoint(token) {
  const base = `${SUPABASE_URL}/functions/v1/quote-share?token=${encodeURIComponent(token)}`;
  return SUPABASE_ANON_KEY ? `${base}&apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/** Fetch the client-facing bundle for a token. Throws on invalid/disabled. */
export async function fetchSharedQuote(token) {
  const r = await fetch(endpoint(token));
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/**
 * Apply ONE of the recipient's picks to the real quote and return the FRESH
 * bundle. The owner chose a single source of truth — picks edit the quote in
 * place, so the response is the re-read quote, not a separate selection blob.
 *
 *   pick = { alternatives: { [group]: lineId } }
 *        | { optionals:    { [lineId]: boolean } }
 *        | { materials:    { [lineOrComponentId]: grade } }
 *        | { materialPick: { [lineOrComponentId]: { grade, fabric, swatchImageId } } }
 *               (an empty grade clears the fabric → restores the model's range)
 */
export async function applyClientPick(token, pick) {
  const r = await fetch(endpoint(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pick || {}),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Mint an unguessable share token (122 bits via crypto.randomUUID). */
export function newShareToken() {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
