/**
 * Render a PDF page to a canvas, then crop named regions to Blobs.
 *
 * Used during import to extract the small vector drawings that the Ligne Roset
 * price list embeds for every product/variant.
 *
 * Browser-only: relies on document.createElement('canvas') and Canvas2D.
 */

/**
 * Render one PDF page at a given scale and return a canvas.
 *   @param pdf       the pdf.js document
 *   @param pageNum   page number (1-based)
 *   @param scale     render scale (2.0 = ~150 DPI for letter)
 *   @returns { canvas, viewport, scale }
 */
export async function renderPdfPage(pdf, pageNum, scale = 2.0) {
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
 * Crop a region of a rendered canvas to a PNG Blob.
 * Region coordinates are in PDF user-space units (not scaled pixels).
 *
 *   @param {Object} options
 *   @param {number} options.maxBlankPct  Reject the crop if more than this
 *      fraction of full-resolution pixels are pure white. 0.999 = only reject
 *      crops that are essentially 100% blank. Set to 1 to disable filtering.
 *   @param {boolean} options.debug  When true, return blank info even if
 *      rejected so callers can log it.
 */
export async function cropCanvasToBlob(canvas, region, scale, opts = {}) {
  const { mime = 'image/png', maxBlankPct = 0.998, debug = false } = opts;
  const { x, y, w, h } = region;
  const sx = Math.max(0, Math.floor(x * scale));
  const sy = Math.max(0, Math.floor(y * scale));
  const sw = Math.min(canvas.width - sx, Math.ceil(w * scale));
  const sh = Math.min(canvas.height - sy, Math.ceil(h * scale));
  if (sw < 10 || sh < 10) return null;

  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  const octx = out.getContext('2d');
  octx.fillStyle = 'white';
  octx.fillRect(0, 0, sw, sh);
  octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

  // Reject completely-blank crops only. Uses full-resolution sampling.
  const blankFrac = pureWhiteFraction(octx, sw, sh);
  if (debug) console.debug('[pageImage] crop', region, '→', sw, 'x', sh, 'blank=', blankFrac.toFixed(3));
  if (blankFrac >= maxBlankPct) return null;

  return new Promise((resolve) => out.toBlob(resolve, mime, 0.92));
}

/**
 * Fraction of pixels that are pure white (255, 255, 255). Faster than
 * sampling and exact. Anti-aliased lines don't count as white so even a thin
 * 1-pixel drawing returns < 1.0.
 */
function pureWhiteFraction(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  const total = w * h;
  let white = 0;
  // Scan every 4th pixel for speed; effectively a 1/4 sample of the area.
  const stride = 4 * 4;
  let samples = 0;
  for (let i = 0; i < data.length; i += stride) {
    samples++;
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) white++;
  }
  return samples ? white / samples : 1;
}
