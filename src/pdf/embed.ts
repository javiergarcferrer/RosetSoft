import type { PDFDocument, PDFImage } from 'pdf-lib';
import { downloadImageBytes } from '../db/database.js';

/**
 * Fetch an image from Supabase Storage and embed it in the PDF document.
 *
 * pdf-lib can only embed PNG and JPEG natively. For SVG sources we rasterize
 * via the browser's Canvas at print resolution so logos drawn as vectors in
 * the app stay crisp in the printed PDF (no blurry up-scaled bitmaps and
 * no manual canvas conversion at upload time).
 */
export async function embedImageById(
  doc: PDFDocument,
  id: string | null | undefined,
): Promise<PDFImage | null> {
  if (!id) return null;
  const res = (await downloadImageBytes(id)) as {
    bytes: Uint8Array;
    contentType: string;
  } | null;
  if (!res?.bytes) return null;
  const ct = (res.contentType || '').toLowerCase();

  if (ct.includes('svg')) {
    const png = await rasterizeSvgToPng(res.bytes);
    return png ? doc.embedPng(png) : null;
  }
  if (ct.includes('png'))                       return doc.embedPng(res.bytes);
  if (ct.includes('jpeg') || ct.includes('jpg')) return doc.embedJpg(res.bytes);

  // Unknown / missing content type — best-effort sniff. If the file is
  // neither PNG nor JPEG, return null and let the caller fall back.
  try { return await doc.embedPng(res.bytes); } catch { /* not a PNG */ }
  try { return await doc.embedJpg(res.bytes); } catch { /* not a JPEG */ }
  return null;
}

// Per-document cache of embedded swatch images keyed by a stable cache key
// (the storage id or the remote url). A swatch — especially a line's base
// material — repeats across many lines; embedding it once keeps the PDF
// small. WeakMap by doc so the cache is collected with the document and
// never leaks across exports.
const swatchByDoc = new WeakMap<PDFDocument, Map<string, PDFImage | null>>();
// Module-level fetched-bytes cache (bytes are document-independent) so the
// same remote swatch is fetched at most once per session.
const urlBytesCache = new Map<string, Uint8Array | null>();

async function fetchImageBytes(url: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Embed a material swatch from EITHER an uploaded Supabase image id OR a
 * remote url (a catalog color's Ligne Roset swatch derived from its code),
 * preferring the uploaded image. Results are memoised per document so a
 * swatch shared across lines is embedded once. Returns null when neither
 * source yields embeddable PNG/JPEG bytes — the caller draws an empty tile.
 */
export async function embedSwatch(
  doc: PDFDocument,
  src: { imageId?: string | null; url?: string | null },
): Promise<PDFImage | null> {
  const key = src.imageId ? `id:${src.imageId}` : src.url ? `url:${src.url}` : '';
  if (!key) return null;
  let cache = swatchByDoc.get(doc);
  if (!cache) { cache = new Map(); swatchByDoc.set(doc, cache); }
  if (cache.has(key)) return cache.get(key) ?? null;

  let img: PDFImage | null = null;
  if (src.imageId) {
    img = await embedImageById(doc, src.imageId);
  } else if (src.url) {
    let bytes = urlBytesCache.get(src.url);
    if (bytes === undefined) {
      bytes = await fetchImageBytes(src.url);
      urlBytesCache.set(src.url, bytes);
    }
    if (bytes) {
      try { img = await doc.embedJpg(bytes); }
      catch {
        try { img = await doc.embedPng(bytes); }
        catch { img = null; }
      }
    }
  }
  cache.set(key, img);
  return img;
}

/**
 * Rasterize SVG bytes to PNG bytes at print-quality resolution.
 *
 * pdf-lib has no vector embed for SVG, so the cleanest way to preserve
 * fidelity is to let the browser render the SVG natively onto a canvas at
 * a resolution far larger than the on-page footprint. The logo's
 * on-page width is ~140pt; a 1600px raster gives ~11x oversampling, which
 * survives both screen viewing and 300-dpi printing without visible
 * aliasing.
 *
 * Aspect ratio is preserved from the SVG's intrinsic dimensions
 * (width/height attributes or viewBox). SVGs that omit both are loaded at
 * the browser's default 300×150 fallback — acceptable for a logo, since
 * any real logo will have explicit dimensions.
 */
async function rasterizeSvgToPng(
  svgBytes: Uint8Array,
  { targetWidth = 1600 }: { targetWidth?: number } = {},
): Promise<Uint8Array | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;

  const svgText = new TextDecoder('utf-8').decode(svgBytes);
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('SVG failed to load'));
      i.src = url;
    });
    // naturalWidth/Height can be 0 when the SVG lacks intrinsic dimensions;
    // fall back to the browser's default-svg-size to keep the aspect ratio
    // sensible instead of producing a 0×0 canvas.
    const naturalW = img.naturalWidth || img.width || 300;
    const naturalH = img.naturalHeight || img.height || 150;
    const w = targetWidth;
    const h = Math.max(1, Math.round(targetWidth * (naturalH / naturalW)));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext('2d');
    if (!cx) return null;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, w, h);

    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) return null;
    return new Uint8Array(await pngBlob.arrayBuffer());
  } catch (e) {
    console.warn('[quotePdf] SVG rasterize failed:', (e as Error)?.message || e);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
