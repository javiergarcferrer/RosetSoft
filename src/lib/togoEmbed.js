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
 * The snippet the dealer pastes into their website. NOT a bare iframe anymore —
 * it's a self-contained LAUNCHER: an attractive "Configura tu Togo" card that,
 * when clicked, opens the configurator in a FULLSCREEN popup (a fixed inset:0
 * overlay holding the iframe, with a close bar + Esc). Zero dependencies, scoped
 * `tgc-` styles, idempotent. The card sits in the page flow; the popup is the
 * full experience. Keeps the same `allow` grants so in-widget AR still works.
 */
export function togoEmbedSnippet() {
  const url = togoEmbedModalUrl();   // the popup iframe is already fullscreen → skip the inner card
  const allow = TOGO_EMBED_ALLOW;
  return `<!-- Togo configurator (Ligne Roset) — launch card + fullscreen popup -->
<div data-togo-launcher>
  <button type="button" class="tgc-card" aria-haspopup="dialog">
    <span class="tgc-art" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 11v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H6v-2a2 2 0 0 0-4 0Z"/><path d="M4 18v2"/><path d="M20 18v2"/><path d="M12 4v9"/></svg></span>
    <span class="tgc-main">
      <span class="tgc-eyebrow">LIGNE ROSET · TOGO</span>
      <span class="tgc-title">Diseña tu Togo a tu medida</span>
      <span class="tgc-sub">Arma tu sofá modular, pruébalo en distintas telas y recibe tu cotización al instante.</span>
      <span class="tgc-cta">Configurar mi Togo <span class="tgc-arrow">&#8594;</span></span>
    </span>
  </button>
</div>
<style>
[data-togo-launcher]{display:flex;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.tgc-card{all:unset;box-sizing:border-box;cursor:pointer;display:flex;gap:18px;align-items:center;width:100%;max-width:520px;padding:18px 20px;border-radius:18px;background:#faf9f7;border:1px solid #e7e3dc;box-shadow:0 14px 34px -18px rgba(28,26,23,.45);transition:transform .18s ease,box-shadow .18s ease}
.tgc-card:hover{transform:translateY(-2px);box-shadow:0 22px 44px -18px rgba(28,26,23,.5)}
.tgc-card:active{transform:translateY(0)}
.tgc-art{flex:0 0 auto;width:88px;height:88px;border-radius:14px;background:#1c1a17;color:#faf9f7;display:flex;align-items:center;justify-content:center}
.tgc-art svg{width:46px;height:46px}
.tgc-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.tgc-eyebrow{font-size:10px;letter-spacing:.13em;font-weight:700;color:#a39c91}
.tgc-title{font-size:19px;font-weight:700;color:#1c1a17;line-height:1.18}
.tgc-sub{font-size:12.5px;color:#6c665d;line-height:1.45}
.tgc-cta{margin-top:7px;display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:#1c1a17}
.tgc-arrow{transition:transform .18s ease}
.tgc-card:hover .tgc-arrow{transform:translateX(4px)}
.tgc-overlay{position:fixed;inset:0;z-index:2147483000;background:#fff;display:flex;flex-direction:column;animation:tgc-fade .22s ease}
@keyframes tgc-fade{from{opacity:0}to{opacity:1}}
.tgc-bar{flex:0 0 auto;height:50px;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 16px;border-bottom:1px solid #ece9e3;background:#faf9f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.tgc-bar-title{font-size:13px;font-weight:600;color:#1c1a17}
.tgc-close{all:unset;cursor:pointer;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#6c665d;font-size:24px;line-height:1;transition:background .15s ease}
.tgc-close:hover{background:#efece6;color:#1c1a17}
.tgc-frame{flex:1 1 auto;width:100%;border:0;display:block}
@media (max-width:480px){.tgc-card{gap:14px;padding:15px 16px}.tgc-art{width:64px;height:64px;border-radius:12px}.tgc-art svg{width:36px;height:36px}.tgc-title{font-size:16px}.tgc-sub{font-size:12px}}
</style>
<script>(function(){var U="${url}",A="${allow}";var L=document.querySelectorAll('[data-togo-launcher]');var root=L[L.length-1];if(!root||root.getAttribute('data-togo-ready'))return;root.setAttribute('data-togo-ready','1');var card=root.querySelector('.tgc-card');var ov=null;function close(){if(!ov)return;if(ov.parentNode)ov.parentNode.removeChild(ov);ov=null;document.documentElement.style.overflow='';document.removeEventListener('keydown',onKey)}function onKey(e){if(e.key==='Escape')close()}function open(){if(ov)return;ov=document.createElement('div');ov.className='tgc-overlay';ov.innerHTML='<div class="tgc-bar"><span class="tgc-bar-title">Configura tu Togo</span><button type="button" class="tgc-close" aria-label="Cerrar">&times;</button></div><iframe class="tgc-frame" src="'+U+'" title="Configurador Togo" allow="'+A+'" allowfullscreen></iframe>';document.body.appendChild(ov);document.documentElement.style.overflow='hidden';ov.querySelector('.tgc-close').addEventListener('click',close);document.addEventListener('keydown',onKey)}if(card)card.addEventListener('click',open)})();</script>`;
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
