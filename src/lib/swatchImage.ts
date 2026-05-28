/**
 * Ligne Roset publishes a per-color swatch at a stable, public, Cloudflare-
 * cached path keyed on the catalog color code we already store
 * (`MaterialColor.code`): code "4479" → .../colorized-pattern/c_4479.jpg.
 *
 * We render these directly (hotlink) rather than copying them into Supabase
 * Storage. Deriving the URL from the code means every seed color shows its
 * own correct swatch with no upload, no import run, and no migration — and a
 * dealer-uploaded photo (`MaterialColor.imageId`) still wins wherever one
 * exists. A missing/discontinued code 404s; ImageView degrades that to its
 * neutral placeholder via onError, so a dead URL never shows a broken image.
 */
const LR_SWATCH_BASE =
  'https://www.ligne-roset.com/media/ligne_roset_us/colorized-pattern';

/** The Ligne Roset swatch image URL for a catalog color code, or null. */
export function swatchUrl(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim();
  if (!c) return null;
  return `${LR_SWATCH_BASE}/c_${encodeURIComponent(c)}.jpg`;
}

// `import.meta.env` is undefined outside Vite (e.g. a node test importing this
// module), so guard it the same way src/db/supabaseClient.ts does.
const VITE_ENV: Record<string, string> =
  ((typeof import.meta !== 'undefined' && import.meta.env) || {}) as Record<string, string>;
const SUPABASE_URL: string = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY: string = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/**
 * The same swatch image as `swatchUrl`, but routed through our `swatch-proxy`
 * Edge Function so the response carries CORS headers.
 *
 * The web preview hotlinks `swatchUrl` directly via <img> — displaying a
 * cross-origin image needs no CORS. The PDF generator (pdf-lib, in the
 * browser) instead has to READ the image bytes to embed them, and the Ligne
 * Roset CDN sends no `Access-Control-Allow-Origin`, so a direct browser fetch
 * is blocked. The proxy fetches it server-side and re-serves it with CORS.
 *
 * Returns null when there's no code or no Supabase URL configured — callers
 * fall back to an empty swatch tile.
 */
export function swatchProxyUrl(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim();
  if (!c || !SUPABASE_URL) return null;
  // Pass the public anon key as a query param (not a header) so the request
  // stays a "simple" GET (no CORS preflight) AND the Supabase gateway accepts
  // it regardless of its default apikey requirement. The anon key is already
  // public in the client bundle, so this exposes nothing new.
  const base = `${SUPABASE_URL}/functions/v1/swatch-proxy?code=${encodeURIComponent(c)}`;
  return SUPABASE_ANON_KEY ? `${base}&apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/**
 * A material's hero swatch URL — its first color's swatch. Mirrors the
 * existing `heroImageId` (a material's face is borrowed from its colors);
 * used as the fallback when no color carries an uploaded photo.
 */
export function heroSwatchUrl(
  material: { colors?: { code?: string | null }[] } | null | undefined,
): string | null {
  return swatchUrl(material?.colors?.[0]?.code);
}
