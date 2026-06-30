// Client helpers for the public, signable contract link.
//
// Mirrors lib/quoteShare: the dealer side writes `shareToken`/`shareEnabled` on
// the payment_plans row through the normal authed db; these helpers are what the
// (logged-out) viewer uses to talk to the `contract-share` Edge Function, plus
// the URL builder. The token is minted with the same `newShareToken`.

import { newShareToken } from './quoteShare.js';
import { PREVIEW_VERSION } from './previewVersion.js';

export { newShareToken };

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/**
 * The shareable contract URL. It points at the static link-preview LAUNCHER
 * `/p/contrato.html` (not the bare `#/contrato/<token>`) so the payment-plan
 * link gets its OWN WhatsApp/iMessage card: the app is a hash-routed SPA, so a
 * crawler only ever reads the head of the real path it fetches — a `#/…` link
 * collapses onto index.html's single (quote) card. The launcher carries the
 * contract og:image and forwards a human into the SPA (see public/p/contrato.html).
 *
 * The `slug/token` suffix rides in `?d=` (the launcher appends it to
 * `#/contrato/`). Each segment is encodeURIComponent'd, so the only raw `/` is
 * the join — query-safe, and it round-trips through URLSearchParams untouched.
 * An optional `slug` reads like the matching document; the token stays the real
 * key (the route ignores the slug).
 */
export function contractLinkUrl(token, slug) {
  if (!token) return '';
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const suffix = slug
    ? `${encodeURIComponent(slug)}/${encodeURIComponent(token)}`
    : encodeURIComponent(token);
  // `pv` (preview version) is a LINK-PREVIEW cache-buster: WhatsApp/Meta freeze
  // the card per URL string for weeks, so a re-shared link keeps showing a stale
  // card. Bump it whenever the og card image is re-rendered (see PREVIEW_VERSION)
  // — a freshly copied link is then a URL WhatsApp hasn't cached, forcing a fresh
  // crawl. The launcher ignores it (reads only `d`).
  return `${origin}/p/contrato.html?d=${suffix}&pv=${PREVIEW_VERSION}`;
}

function endpoint(token) {
  const base = `${SUPABASE_URL}/functions/v1/contract-share?token=${encodeURIComponent(token)}`;
  return SUPABASE_ANON_KEY ? `${base}&apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/** Fetch the client-facing contract bundle for a token. Throws on invalid/disabled. */
export async function fetchSharedContract(token) {
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
 * Submit the client's signature. `signature` = { signerName, signerDoc,
 * signatureDataUrl, signedPdfBase64 }. Returns the fresh (now-signed) bundle.
 */
export async function signSharedContract(token, signature) {
  const r = await fetch(endpoint(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signature || {}),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}
