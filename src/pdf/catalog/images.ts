import { downloadImageBytes } from '../../db/database.js';

/**
 * Pre-resolution pass for the catalog PDF: every model card's photo fetched
 * and normalized to a JPEG data URI react-pdf can embed. Two jobs the quote
 * resolver (pdf/react/images.ts) doesn't do, which is why this isn't a reuse:
 *   • the LSG mirrors can be WEBP (Shopify CDN's preferred format) and
 *     react-pdf embeds PNG/JPEG only → transcode through a browser canvas;
 *   • a full catalog is hundreds of photos → downscale to card resolution so
 *     the document stays WhatsApp-friendly in size.
 * Same graceful degradation as the quote: a photo that can't load/decode is
 * simply absent from the map and the card draws an empty framed tile.
 */
export type CatalogImageMap = Map<string, string>;

export interface CatalogImageSrc {
  key: string;
  imageId?: string | null;
  imageSrc?: string | null;
}

const MAX_WIDTH = 640;   // points×~1.5 — plenty for a half-page card
const JPEG_QUALITY = 0.78;
const PARALLEL = 6;
const FETCH_TIMEOUT_MS = 8000;

export async function resolveCatalogImages(sources: CatalogImageSrc[]): Promise<CatalogImageMap> {
  const map: CatalogImageMap = new Map();
  const queue = [...sources];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let src = queue.shift(); src; src = queue.shift()) {
      try {
        const uri = await resolveOne(src);
        if (uri) map.set(src.key, uri);
      } catch { /* leave absent → empty tile */ }
    }
  }));
  return map;
}

async function resolveOne(src: CatalogImageSrc): Promise<string | null> {
  // Mirrored copy first (our bucket, authed download), store CDN as fallback —
  // the same order ImageView resolves on screen.
  if (src.imageId) {
    const res = await downloadImageBytes(src.imageId).catch(() => null);
    if (res?.bytes) {
      const blob = new Blob([res.bytes as BlobPart], { type: res.contentType || 'image/jpeg' });
      const uri = await toJpegDataUri(blob);
      if (uri) return uri;
    }
  }
  if (src.imageSrc) {
    // Shopify's CDN resizes on demand; ask for card width up front.
    const url = src.imageSrc + (src.imageSrc.includes('?') ? '&' : '?') + `width=${MAX_WIDTH}`;
    const blob = await fetchBlob(url);
    if (blob) return toJpegDataUri(blob);
  }
  return null;
}

async function fetchBlob(url: string): Promise<Blob | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode any browser-readable image (webp included) and re-encode as a JPEG
 * data URI at card resolution. The white underpaint matters: JPEG has no
 * alpha, so a transparent PNG would otherwise composite onto black.
 */
async function toJpegDataUri(blob: Blob): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image failed to decode'));
      i.src = url;
    });
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    if (!naturalW || !naturalH) return null;
    const w = Math.min(MAX_WIDTH, naturalW);
    const h = Math.max(1, Math.round(w * (naturalH / naturalW)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext('2d');
    if (!cx) return null;
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, w, h);
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
