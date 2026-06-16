// Client helpers for the PUBLIC, no-login Togo configurator widget — what the
// logged-OUT embed page (#/embed/togo) uses to talk to the `togo-embed` Edge
// Function. The anon key rides as a query param (gateway-acceptable without a
// custom header, so the CORS preflight passes), exactly like the storefront.

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/** The embeddable widget URL (HashRouter, so `/#/embed/togo`). */
export function togoEmbedUrl() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/#/embed/togo`;
}

/** The `<iframe>` snippet the dealer pastes into their website. */
export function togoEmbedSnippet() {
  return `<iframe src="${togoEmbedUrl()}" width="100%" height="760" style="border:0;border-radius:12px" title="Configurador Togo" loading="lazy"></iframe>`;
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
