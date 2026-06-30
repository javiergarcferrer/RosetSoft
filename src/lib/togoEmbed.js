// Client helpers for the PUBLIC, no-login Togo configurator widget — what the
// logged-OUT embed page (#/embed/togo) uses to talk to the `togo-embed` Edge
// Function. The anon key rides as a query param (gateway-acceptable without a
// custom header, so the CORS preflight passes), exactly like the storefront.

import { PREVIEW_VERSION } from './previewVersion.js';

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/** The embeddable widget URL (HashRouter, so `/#/embed/togo`). Shows the launch
 *  card first (the embed route gates itself behind it). */
export function togoEmbedUrl() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/#/embed/togo`;
}

/**
 * The shareable configurator URL (for WhatsApp / social, NOT for the iframe).
 * It points at the static link-preview LAUNCHER `/p/togo.html` so the
 * configurator link gets its OWN card instead of the generic quote one (the app
 * is a hash-routed SPA — see public/p/togo.html). The launcher forwards straight
 * to `/configurator` (the clean public URL). The iframe embed (togoEmbedSnippet)
 * keeps the DIRECT
 * `togoEmbedUrl` — an iframe must not bounce through a redirect, and it needs
 * the height-reporting launch card, not a preview shim.
 */
export function togoShareUrl() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  // `pv` busts WhatsApp's per-URL preview cache when the card is re-rendered.
  return `${origin}/p/togo.html?pv=${PREVIEW_VERSION}`;
}

/** Same widget, flagged as ALREADY inside a fullscreen container (a host-page
 *  overlay or the in-app modal) → it skips its own launch card and drops straight
 *  into the configurator, so there's never a card-inside-a-card. */
export function togoEmbedModalUrl() {
  return `${togoEmbedUrl()}?ctx=modal`;
}

// The device-capability grants the in-widget "Ver en tu espacio" (WebAR) needs
// to reach the camera + motion sensors from inside a (cross-origin) iframe.
// Without these on the host's <iframe>, AR Quick Look / WebXR is blocked.
export const TOGO_EMBED_ALLOW = 'xr-spatial-tracking; camera; gyroscope; accelerometer; magnetometer; fullscreen';

/**
 * The snippet the dealer pastes into their website: a SELF-SIZING iframe of the
 * launch card (the card — real Togo silhouette, "Togo Configurator" in Rauschen,
 * brand type — lives in the route, our origin, so it's always on-brand). The card
 * reports its natural height and the tiny script shrink-wraps the iframe to it →
 * zero dead space. Tapping the card opens the configurator in a NEW TAB.
 */
export function togoEmbedSnippet() {
  const cardUrl = togoEmbedUrl();   // the launch card (it opens the configurator in a new tab itself)
  return `<!-- Togo configurator (Ligne Roset) — self-sizing launch card -->
<div data-togo-embed style="width:100%;max-width:480px;margin:0 auto">
  <iframe src="${cardUrl}" title="Togo Configurator" scrolling="no" style="width:100%;border:0;display:block;height:520px;overflow:hidden;color-scheme:light"></iframe>
</div>
<script>(function(){var B=document.querySelectorAll('[data-togo-embed]');var box=B[B.length-1];if(!box||box.getAttribute('data-ready'))return;box.setAttribute('data-ready','1');var ifr=box.querySelector('iframe');window.addEventListener('message',function(e){var d=e.data;if(d&&d.type==='togo-embed-height'&&d.height>0&&ifr&&e.source===ifr.contentWindow){ifr.style.height=d.height+'px'}})})();</script>`;
}

function endpoint() {
  const base = `${SUPABASE_URL}/functions/v1/togo-embed`;
  return SUPABASE_ANON_KEY ? `${base}?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/** Fetch the public Togo catalog: { configured, storeName, logoImageId, rates, models[] }. */
export async function fetchTogoCatalog() {
  const r = await fetch(endpoint());
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/**
 * Submit a quote request (a lead). `payload` =
 *   { contact: { name, phone, email }, items: [{ modelId, x, y, rot }],
 *     estimateUsd?, note? }
 * The lead lands as a PENDING togo_request on the dealer's Togo workspace (it is
 * NOT auto-injected into Cotizaciones). Resolves to { ok } or throws.
 */
export async function submitTogoRequest(payload) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.ok) {
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return body;
}
