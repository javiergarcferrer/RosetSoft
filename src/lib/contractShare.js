// Client helpers for the public, signable contract link.
//
// Mirrors lib/quoteShare: the dealer side writes `shareToken`/`shareEnabled` on
// the payment_plans row through the normal authed db; these helpers are what the
// (logged-out) viewer uses to talk to the `contract-share` Edge Function, plus
// the URL builder. The token is minted with the same `newShareToken`.

import { newShareToken } from './quoteShare.js';

export { newShareToken };

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/**
 * The shareable contract URL. HashRouter, so `/#/contrato/<token>`. An optional
 * `slug` reads like the matching document, mirroring shareLinkUrl; the token
 * stays the real key (the route ignores the slug).
 */
export function contractLinkUrl(token, slug) {
  if (!token) return '';
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const path = slug
    ? `${encodeURIComponent(slug)}/${encodeURIComponent(token)}`
    : encodeURIComponent(token);
  return `${origin}/#/contrato/${path}`;
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
