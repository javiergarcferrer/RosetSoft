/**
 * Pure key helpers shared by the async image resolver (`images.ts`, which
 * pulls Supabase) and the sync renderer (`QuoteDocument.tsx`, which must stay
 * DB-free so it renders in Node too). Both derive the SAME map keys from the
 * same inputs, so a resolved image is found by the component that draws it.
 */

/** key → data URI (PNG/JPEG). Missing key ⇒ the renderer draws an empty tile. */
export type ImageMap = Map<string, string>;

/** Product cover photo, keyed by line id. */
export const coverKey = (lineId: string): string => `cover:${lineId}`;

/**
 * A swatch, keyed by its SOURCE (uploaded image id, else remote url) so the
 * same swatch shared across lines/options resolves once. Mirrors embed.ts's
 * per-doc swatch cache key. Returns null when neither source is present.
 */
export function swatchKey(src: { imageId?: string | null; url?: string | null }): string | null {
  if (src.imageId) return `sw:id:${src.imageId}`;
  if (src.url) return `sw:url:${src.url}`;
  return null;
}
