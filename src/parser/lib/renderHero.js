// Render a PDF page and crop the product-hero region.
//
// PyMuPDF's `page.get_image_info(xrefs=True)` extracts the raw image XObjects
// embedded on a page. PDF.js has no equivalent API, so we take the
// onboarding doc's suggested fallback: render the page to a canvas at a
// modest scale, then crop the region of interest.
//
// For the catalog, the "hero" sits in the upper portion of each product's
// intro page (roughly the top 60% of the page, between the page-margin band
// and the data-table area). We crop generously and let downstream UI scale
// it down for thumbnails.

const SCALE = 1.5;            // ~150 dpi at letter size — good for screen thumbs
const JPEG_QUALITY = 0.82;

// Crop box, in PDF user-space units. Page is 595 × 842 (A4ish) or 612 × 792
// (US Letter); both have margins around 28 pt and the hero in roughly the
// same band.
const CROP = { xPct: 0.04, yPct: 0.06, wPct: 0.92, hPct: 0.55 };

/**
 * Render `pageNumber` of `pdf` and return a JPEG Blob of the hero region.
 * Resolves to null if the rendered region is essentially blank (e.g.
 * intro spreads that print only text).
 */
export async function renderProductHero(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: SCALE });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const cropX = Math.floor(canvas.width * CROP.xPct);
  const cropY = Math.floor(canvas.height * CROP.yPct);
  const cropW = Math.floor(canvas.width * CROP.wPct);
  const cropH = Math.floor(canvas.height * CROP.hPct);

  const out = document.createElement('canvas');
  out.width = cropW;
  out.height = cropH;
  const octx = out.getContext('2d');
  octx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  // Reject crops that are essentially solid white (text-only intros, blank
  // pages). Sampling every 16th pixel keeps this cheap.
  if (isMostlyBlank(octx, cropW, cropH)) return null;

  return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
}

function isMostlyBlank(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let whitish = 0;
  let samples = 0;
  for (let i = 0; i < data.length; i += 16 * 4) {
    samples++;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 245 && g > 245 && b > 245) whitish++;
  }
  if (!samples) return true;
  return whitish / samples > 0.985;
}
