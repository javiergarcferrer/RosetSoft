/**
 * Image-optimisation helpers for the PDF importer.
 *
 * The importer used to crop product/variant drawings as full-resolution PNGs
 * at PDF render scale 2.0. For a 150-page TARIF that produced ~50 heroes at
 * roughly 1100x800 pixels each — 300–500 KB of PNG per hero, ~20 MB of
 * upload payload over what is often a residential cellular link. PNG is
 * also a poor encoding for these anti-aliased line drawings (5–10x larger
 * than equivalent-quality JPEG).
 *
 * `canvasRegionToOptimizedBlob` crops a region from an already-rendered
 * source canvas, downscales it so the longest edge is at most
 * `maxLongEdgePx` (default 800px — generous for any thumbnail UI in the
 * app and still readable at full-page in the exported PDF), and encodes
 * it as JPEG at quality 0.85 by default. Catalog views never display
 * these any larger than a few hundred pixels, so the visual quality
 * is identical and uploads drop ~10x in size.
 */

/**
 * Crop, downscale, and encode a region of a rendered PDF canvas.
 *
 *   @param {HTMLCanvasElement} canvas   source canvas (from renderPdfPage)
 *   @param {{x,y,w,h}}          region   in PDF user-space units (not pixels)
 *   @param {number}             scale    the render scale used to rasterise canvas
 *   @param {Object}             opts
 *   @param {number}   opts.maxLongEdgePx   default 800
 *   @param {number}   opts.maxBlankPct     default 0.998 — reject mostly-blank crops
 *   @param {string}   opts.mime            default 'image/jpeg'
 *   @param {number}   opts.quality         default 0.85
 *   @param {boolean}  opts.debug
 *   @returns {Promise<Blob|null>}
 */
export async function canvasRegionToOptimizedBlob(canvas, region, scale, opts = {}) {
  const {
    maxLongEdgePx = 800,
    maxBlankPct = 0.998,
    mime = 'image/jpeg',
    quality = 0.85,
    debug = false,
  } = opts;
  const { x, y, w, h } = region;
  const sx = Math.max(0, Math.floor(x * scale));
  const sy = Math.max(0, Math.floor(y * scale));
  const sw = Math.min(canvas.width - sx, Math.ceil(w * scale));
  const sh = Math.min(canvas.height - sy, Math.ceil(h * scale));
  if (sw < 10 || sh < 10) return null;

  // First pass: pull the cropped region into a small canvas, at SOURCE
  // resolution, so we can run the blank-detector accurately before we
  // pay the downscale cost.
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = sw;
  cropCanvas.height = sh;
  const cctx = cropCanvas.getContext('2d');
  cctx.fillStyle = 'white';
  cctx.fillRect(0, 0, sw, sh);
  cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

  const blankFrac = pureWhiteFraction(cctx, sw, sh);
  if (debug) console.debug('[imageOptimize] crop', region, '->', sw, 'x', sh, 'blank=', blankFrac.toFixed(3));
  if (blankFrac >= maxBlankPct) return null;

  // Second pass: downscale to the target max longest edge. Bilinear is
  // fine for line drawings — these end up displayed at 100–300px in
  // every catalog/quote view, so we have headroom.
  const longEdge = Math.max(sw, sh);
  let outW = sw;
  let outH = sh;
  if (longEdge > maxLongEdgePx) {
    const ratio = maxLongEdgePx / longEdge;
    outW = Math.max(1, Math.round(sw * ratio));
    outH = Math.max(1, Math.round(sh * ratio));
  }

  let encodeCanvas = cropCanvas;
  if (outW !== sw || outH !== sh) {
    encodeCanvas = document.createElement('canvas');
    encodeCanvas.width = outW;
    encodeCanvas.height = outH;
    const octx = encodeCanvas.getContext('2d');
    // JPEG ignores alpha; explicit white background guards against any
    // browser quirks if the source ever carries transparency.
    octx.fillStyle = 'white';
    octx.fillRect(0, 0, outW, outH);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(cropCanvas, 0, 0, sw, sh, 0, 0, outW, outH);
  }

  return new Promise((resolve) => encodeCanvas.toBlob(resolve, mime, quality));
}

/**
 * Fraction of pixels that are pure white (255, 255, 255). Anti-aliased
 * lines don't count so even a thin drawing returns < 1.0.
 *
 * Samples every 4th pixel for speed (1/4 sample of area).
 */
function pureWhiteFraction(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let white = 0;
  let samples = 0;
  const stride = 4 * 4;
  for (let i = 0; i < data.length; i += stride) {
    samples++;
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) white++;
  }
  return samples ? white / samples : 1;
}
