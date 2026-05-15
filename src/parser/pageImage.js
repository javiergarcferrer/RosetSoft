/**
 * Render a PDF page to a canvas, then crop named regions to Blobs.
 *
 * Used during import to extract the small vector drawings that the Ligne Roset
 * price list embeds for every product/variant.
 *
 * Browser-only: relies on document.createElement('canvas') and Canvas2D.
 *
 * Performance note (May 2026): the render scale used to be 2.0 (~150 DPI),
 * which produced ~1200×1700 pixel canvases. Each render is single-threaded
 * CPU work on the main JS thread that blocks the UI, so 50 product pages
 * meant tens of seconds of perceived freeze before any upload could even
 * start. Scale 1.25 is plenty for the small drawings we crop out (every
 * crop is then downscaled further in imageOptimize.js), and roughly halves
 * the per-page render budget.
 */

import { canvasRegionToOptimizedBlob } from './imageOptimize.js';

/**
 * Render one PDF page at a given scale and return a canvas.
 *   @param pdf       the pdf.js document
 *   @param pageNum   page number (1-based)
 *   @param scale     render scale (1.25 ≈ 90 DPI for letter — enough for
 *                    the small drawings we crop, since each crop is then
 *                    downscaled to ≤ 800px on the longest edge)
 *   @returns { canvas, viewport, scale }
 */
export async function renderPdfPage(pdf, pageNum, scale = 1.25) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  // White background — PDFs render with transparency by default
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, viewport, scale };
}

/**
 * Crop a region of a rendered canvas to a Blob suitable for catalog/quote
 * display. Defaults to JPEG @ 0.85 with a longest-edge cap of 800px —
 * see imageOptimize.js for the rationale.
 *
 * Region coordinates are in PDF user-space units (not scaled pixels).
 */
export async function cropCanvasToBlob(canvas, region, scale, opts = {}) {
  return canvasRegionToOptimizedBlob(canvas, region, scale, opts);
}
