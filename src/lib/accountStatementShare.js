// Client helpers for the public customer-statement link (estado de cuenta).
// Mirrors lib/contractShare: the dealer writes `statementToken` on the customer
// row through the normal authed db; these helpers are what the logged-out viewer
// uses to talk to the `account-share` Edge Function, plus the URL builder.
import { newShareToken } from './quoteShare.js';
import { PREVIEW_VERSION } from './previewVersion.js';

export { newShareToken };

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/**
 * The shareable statement URL. It points at the static link-preview LAUNCHER
 * `/p/cuenta.html` (not the bare `#/cuenta/<token>`) so the estado-de-cuenta
 * link gets its OWN WhatsApp/iMessage card instead of the generic quote one
 * (see public/p/cuenta.html for the hash-routed-SPA rationale). The token rides
 * in `?d=`; the launcher appends it to `#/cuenta/`.
 */
export function statementLinkUrl(token) {
  if (!token) return '';
  const origin = typeof location !== 'undefined' ? location.origin : '';
  // `pv` busts WhatsApp's per-URL preview cache when the card is re-rendered.
  return `${origin}/p/cuenta.html?d=${encodeURIComponent(token)}&pv=${PREVIEW_VERSION}`;
}

function endpoint(token) {
  const base = `${SUPABASE_URL}/functions/v1/account-share?token=${encodeURIComponent(token)}`;
  return SUPABASE_ANON_KEY ? `${base}&apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/** Fetch the client-facing statement bundle for a token. Throws on invalid/revoked. */
export async function fetchSharedStatement(token) {
  const r = await fetch(endpoint(token));
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}
