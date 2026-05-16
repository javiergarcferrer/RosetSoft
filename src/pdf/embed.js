import { downloadImageBytes } from '../db/database.js';

/**
 * Fetch an image from Supabase Storage and embed it in the PDF document.
 *
 * pdf-lib can only embed PNG and JPEG natively. For SVG sources we rasterize
 * via the browser's Canvas at print resolution so logos drawn as vectors in
 * the app stay crisp in the printed PDF (no blurry up-scaled bitmaps and
 * no manual canvas conversion at upload time).
 */
export async function embedImageById(doc, id) {
  if (!id) return null;
  const res = await downloadImageBytes(id);
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
async function rasterizeSvgToPng(svgBytes, { targetWidth = 1600 } = {}) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;

  const svgText = new TextDecoder('utf-8').decode(svgBytes);
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
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
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, w, h);

    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) return null;
    return new Uint8Array(await pngBlob.arrayBuffer());
  } catch (e) {
    console.warn('[quotePdf] SVG rasterize failed:', e?.message || e);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
