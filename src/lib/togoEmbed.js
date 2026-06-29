// Client helpers for the PUBLIC, no-login Togo configurator widget — what the
// logged-OUT embed page (#/embed/togo) uses to talk to the `togo-embed` Edge
// Function. The anon key rides as a query param (gateway-acceptable without a
// custom header, so the CORS preflight passes), exactly like the storefront.

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/** The embeddable widget URL (HashRouter, so `/#/embed/togo`). Shows the launch
 *  card first (the embed route gates itself behind it). */
export function togoEmbedUrl() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/#/embed/togo`;
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
 * The snippet the dealer pastes into their website: a self-contained, zero-JS
 * launch CARD — a REAL Togo silhouette, the "Togo Configurator" wordmark in
 * Rauschen, eyebrow in Söhne, body in Lausanne (all served from our origin). It's
 * an anchor that opens the configurator in a NEW TAB (full screen, no iframe
 * limits). Scoped `tgc-` styles; nothing else on the page is touched.
 */
export function togoEmbedSnippet() {
  const url = togoEmbedModalUrl();   // opens straight into the build (skips the inner card)
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `<!-- Togo configurator (Ligne Roset) — launch card → opens in a new tab -->
<div data-togo-launcher>
  <a class="tgc-card" href="${url}" target="_blank" rel="noopener">
    <span class="tgc-eyebrow">Ligne Roset</span>
    <img class="tgc-hero" src="${origin}/togo-hero.svg" alt="Togo" loading="lazy" />
    <span class="tgc-title">Togo Configurator</span>
    <span class="tgc-sub">Arma tu sofá modular, pruébalo en distintas telas y recibe tu cotización al instante.</span>
    <span class="tgc-cta">Empezar a diseñar <span class="tgc-arrow">&#8594;</span></span>
  </a>
</div>
<style>
@font-face{font-family:'Rauschen B';src:url('${origin}/fonts/RauschenB-Semibold.woff2') format('woff2');font-weight:600;font-display:swap}
@font-face{font-family:'TgcSohne';src:url('${origin}/fonts/Sohne-Halbfett.woff2') format('woff2');font-weight:400 700;font-display:swap}
@font-face{font-family:'TgcLausanne';src:url('${origin}/fonts/Lausanne-400.woff2') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:'TgcLausanne';src:url('${origin}/fonts/Lausanne-600.woff2') format('woff2');font-weight:600;font-display:swap}
[data-togo-launcher]{display:flex;justify-content:center}
.tgc-card{box-sizing:border-box;cursor:pointer;text-decoration:none;display:flex;flex-direction:column;align-items:center;text-align:center;width:100%;max-width:380px;padding:26px 26px 22px;border-radius:22px;background:#f4f1ec;border:1px solid #e7e3dc;box-shadow:0 18px 42px -22px rgba(28,26,23,.5);font-family:'TgcLausanne',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;transition:transform .18s ease,box-shadow .18s ease}
.tgc-card:hover{transform:translateY(-2px);box-shadow:0 26px 52px -22px rgba(28,26,23,.55)}
.tgc-card:active{transform:translateY(0)}
.tgc-eyebrow{font-family:'TgcSohne',sans-serif;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#a39c91;font-weight:600}
.tgc-hero{width:100%;max-width:240px;height:auto;display:block;margin:14px 0 2px}
.tgc-title{font-family:'Rauschen B','TgcSohne',serif;font-weight:600;font-size:30px;line-height:1;color:#1c1a17;margin-top:8px}
.tgc-sub{font-size:12.5px;color:#6c665d;line-height:1.45;margin-top:10px;max-width:260px}
.tgc-cta{margin-top:18px;display:inline-flex;align-items:center;gap:8px;background:#1c1a17;color:#faf9f7;border-radius:999px;padding:11px 20px;font-size:13px}
.tgc-arrow{transition:transform .18s ease}
.tgc-card:hover .tgc-arrow{transform:translateX(4px)}
@media (max-width:480px){.tgc-card{padding:22px 20px 20px}.tgc-hero{max-width:210px}.tgc-title{font-size:26px}}
</style>`;
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
