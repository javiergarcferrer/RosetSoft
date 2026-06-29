// Client helpers for the public, no-login storefront ("Tienda").
//
// The dealer designates the house-account customer through the normal authed db
// (settings.storeCustomerId); these helpers are what the LOGGED-OUT storefront
// page uses to talk to the public `store` Edge Function, plus the URL builder.

const VITE_ENV =
  (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/**
 * The shareable storefront URL. It points at the static link-preview LAUNCHER
 * `/p/tienda.html` (not the bare `#/tienda`) so the Tienda link gets its OWN
 * WhatsApp/iMessage card instead of the generic quote one (see
 * public/p/tienda.html for the hash-routed-SPA rationale). The launcher forwards
 * straight to `#/tienda`.
 */
export function storeLinkUrl() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/p/tienda.html`;
}

/**
 * Build a contact deep-link from the dealer's public phone number. Returns a
 * WhatsApp `wa.me` link when the number cleans to a plausible international
 * number (the dealer's default channel), else a `tel:` link, else null when
 * there's no usable number. `message` (optional) pre-fills the WhatsApp chat.
 */
export function contactLinkFor(phone, message) {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  // Keep the leading + only as an intl marker; wa.me wants digits only.
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // wa.me needs a country code. Assume DR (+1) for the local 10-digit form
  // (809/829/849) when no explicit + / country code was given.
  let waDigits = digits;
  if (!hasPlus && digits.length === 10) waDigits = `1${digits}`;
  if (waDigits.length >= 11) {
    const q = message ? `?text=${encodeURIComponent(message)}` : '';
    return { kind: 'whatsapp', href: `https://wa.me/${waDigits}${q}` };
  }
  return { kind: 'tel', href: `tel:${hasPlus ? '+' : ''}${digits}` };
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
 *   { configured, storeName, logoImageId, contactPhone, rates, quotes[], lines[], orders[] }
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
