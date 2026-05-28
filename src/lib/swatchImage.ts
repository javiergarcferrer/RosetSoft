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
