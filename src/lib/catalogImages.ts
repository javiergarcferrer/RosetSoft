/**
 * Brand-catalog photo facts shared by the resolvers (ImageView,
 * downloadImageBytes) and the quote editor's photo widgets.
 *
 * LifestyleGarden photos are CDN POINTERS: `images` rows that carry the
 * Shopify CDN url (`externalUrl`) and no bytes in our bucket. Two
 * consequences live here:
 *   • the pointer is SHARED — products and any number of quote lines
 *     reference the same row, so a line clearing its photo must UNLINK,
 *     never delete the row;
 *   • the CDN resizes on demand — always ask for a bounded width so a
 *     4000-px original never ships to a phone or bloats a PDF.
 */

/** Pointer ids are content-addressed by the sync: `lsgimg-<sha1 of url>`. */
export function isSharedCatalogImage(id: string | null | undefined): boolean {
  return !!id && id.startsWith('lsgimg-');
}

/**
 * The url to actually fetch for a remote catalog photo: Shopify's CDN gets a
 * width cap appended (it resizes on demand); any other host is left alone —
 * foreign CDNs may not understand the param.
 */
export function sizedExternalUrl(url: string, width: number): string {
  if (!/^https:\/\/cdn\.shopify\.com\//.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + `width=${width}`;
}

/** On-screen rendering (thumbnails, hover zoom, gallery). */
export const SCREEN_IMG_WIDTH = 1200;
/** Byte downloads (PDF embedding) — print wants a little more. */
export const DOWNLOAD_IMG_WIDTH = 1600;
