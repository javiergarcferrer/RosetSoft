import { downloadImageBytes, db } from '../../db/database.js';
import { publicImageUrl } from '../../db/supabaseClient.js';
import { isCompoundLine } from '../../lib/pricing.js';
import { materialCells, swatchSrcFor } from './materialCells.js';
import { coverKey, swatchKey } from './imageKeys.js';
import type { ImageMap } from './imageKeys.js';
import type { QuoteLine, Settings, CurrencyCode } from '../../types/domain.ts';
import type { CatalogFamily } from '../../lib/catalog.ts';

/**
 * Pre-resolution pass for the react-pdf quote. react-pdf needs every image as
 * a ready byte source at render time (it can't await a Supabase download
 * mid-layout), so we collect ALL image references in the quote — the logo,
 * the FX bank logo, each line's cover photo, standalone + component swatches,
 * and every material-option swatch — and fetch them to data URIs up front.
 * `QuoteDocument` then reads this map synchronously and stays DB-free (so it
 * also renders in Node).
 *
 * Replaces the legacy pdf-lib `embed.ts`: same sources (uploaded id OR the
 * catalog color's CORS-proxied remote swatch), same SVG-logo rasterization,
 * same graceful degradation — a source that can't load is simply absent from
 * the map and the renderer draws an empty framed tile.
 */
type Src = { imageId?: string | null; url?: string | null };

export async function resolveQuoteImages({
  settings, lines, families, currency, publicUrls = false,
}: {
  settings: Settings | null | undefined;
  lines: QuoteLine[];
  families?: Map<string, CatalogFamily> | null;
  currency: CurrencyCode;
  /** Public client link (anonymous): resolve ids via the public bucket URL
   *  instead of the authed storage download (which isn't available there). */
  publicUrls?: boolean;
}): Promise<ImageMap> {
  const sources = new Map<string, Src>();
  const addId = (key: string, imageId: string | null | undefined): void => {
    if (imageId) sources.set(key, { imageId });
  };
  const addSwatch = (src: Src): void => {
    const k = swatchKey(src);
    if (k && !sources.has(k)) sources.set(k, src);
  };
  // Material-option swatches for a line/component (notes unused here → empty rates).
  const addOptionSwatches = (
    mo: QuoteLine['materialOptions'], reference: string | null | undefined, baseSwatch: string | null | undefined,
  ): void => {
    for (const cell of materialCells({ mo, reference, baseSwatchImageId: baseSwatch, families, currency, rates: {} })) {
      addSwatch(cell.swatch);
    }
  };

  addId('logo', settings?.logoImageId);
  addId('rateLogo', settings?.rateLogoImageId);

  for (const line of lines) {
    addId(coverKey(line.id), line.imageId);
    // Uploaded swatch OR the catalog color derived from the subtype (proxy URL).
    addSwatch(swatchSrcFor(line.swatchImageId, line.subtype));
    addOptionSwatches(line.materialOptions, line.reference, line.swatchImageId);
    if (isCompoundLine(line) && Array.isArray(line.components)) {
      for (const c of line.components) {
        addSwatch(swatchSrcFor(c.swatchImageId, c.subtype));
        addOptionSwatches(c.materialOptions, c.reference, c.swatchImageId);
      }
    }
  }

  const map: ImageMap = new Map();
  await Promise.all([...sources].map(async ([key, src]) => {
    try {
      const uri = await resolveOne(src, publicUrls);
      if (uri) map.set(key, uri);
    } catch { /* leave absent → empty tile */ }
  }));
  return map;
}

async function resolveOne(src: Src, publicUrls: boolean): Promise<string | null> {
  if (src.imageId) {
    // Public link (anonymous): the authed storage download isn't available, so
    // resolve through the public bucket URL — the same path ImageView uses
    // (db.images.get works for anon; the bucket is public).
    if (publicUrls) {
      const rec = await db.images.get(src.imageId) as { storagePath?: string } | null | undefined;
      const url = rec?.storagePath ? publicImageUrl(rec.storagePath) : null;
      const bytes = url ? await fetchUrlBytes(url) : null;
      return bytes ? bytesToDataUri(bytes, '') : null;
    }
    const res = await downloadImageBytes(src.imageId);
    return res?.bytes ? bytesToDataUri(res.bytes, res.contentType) : null;
  }
  if (src.url) {
    const bytes = await fetchUrlBytes(src.url);
    return bytes ? bytesToDataUri(bytes, '') : null;
  }
  return null;
}

async function fetchUrlBytes(url: string): Promise<Uint8Array | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function bytesToDataUri(bytes: Uint8Array, contentType: string): Promise<string | null> {
  const ct = (contentType || '').toLowerCase();
  // SVG → rasterize to PNG (react-pdf <Image> embeds raster only).
  if (ct.includes('svg') || looksLikeSvg(bytes)) {
    const png = await rasterizeSvgToPng(bytes);
    return png ? `data:image/png;base64,${toBase64(png)}` : null;
  }
  const mime = ct.includes('png') || isPng(bytes) ? 'image/png'
    : ct.includes('jpeg') || ct.includes('jpg') || isJpeg(bytes) ? 'image/jpeg'
    : isPng(bytes) ? 'image/png' : isJpeg(bytes) ? 'image/jpeg' : null;
  if (!mime) return null;
  return `data:${mime};base64,${toBase64(bytes)}`;
}

const isPng = (b: Uint8Array) => b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8;
function looksLikeSvg(b: Uint8Array): boolean {
  // sniff the first bytes for "<svg" / "<?xml"
  const head = new TextDecoder('utf-8').decode(b.slice(0, 64)).trim().toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('svg'));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Rasterize SVG bytes to PNG bytes at print resolution via the browser
 * canvas — ported from the legacy embed.ts. react-pdf can't embed SVG files,
 * so a vector logo is oversampled to a crisp raster. Returns null outside a
 * browser (e.g. the Node verification harness), where the logo falls back to
 * the typeset company name.
 */
async function rasterizeSvgToPng(svgBytes: Uint8Array, targetWidth = 1600): Promise<Uint8Array | null> {
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
    const naturalW = img.naturalWidth || img.width || 300;
    const naturalH = img.naturalHeight || img.height || 150;
    const w = targetWidth;
    const h = Math.max(1, Math.round(targetWidth * (naturalH / naturalW)));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const cx = canvas.getContext('2d');
    if (!cx) return null;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, w, h);
    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) return null;
    return new Uint8Array(await pngBlob.arrayBuffer());
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
