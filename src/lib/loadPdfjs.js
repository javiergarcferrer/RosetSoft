/**
 * Shared pdfjs-dist loader — dynamically imported so the (heavy) PDF engine
 * stays out of the main bundle, with the worker wired once. Used by the
 * Roset-invoice parser (text extraction) and the in-app print preview
 * (page rasterization). Goes through safeDynamicImport so a stale deploy
 * recovers instead of stranding the user (see lib/dynamicImport.js).
 */
import { safeDynamicImport } from './dynamicImport.js';

let workerReady = false;

export async function loadPdfjs() {
  const pdfjsLib = await safeDynamicImport(() => import('pdfjs-dist'));
  if (!workerReady) {
    try {
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    } catch {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
    }
    workerReady = true;
  }
  return pdfjsLib;
}

/**
 * Rasterize every page of a PDF blob to PNG data URLs, sized for print
 * (~180 dpi for an A4/Letter page). Returns [{ src, width, height, widthPt,
 * heightPt }] in page order — `width`/`height` are the raster pixels, while
 * `widthPt`/`heightPt` are the PDF page's own size in points (the print
 * preview sizes each printed sheet to these so a page-filling image can't
 * overflow onto a blank trailing sheet). Pure rendering — no DOM beyond an
 * off-screen canvas.
 */
export async function renderPdfToImages(blob, { targetWidthPx = 1500 } = {}) {
  const pdfjsLib = await loadPdfjs();
  const buf = await blob.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(1.5, targetWidthPx / base.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push({
        src: canvas.toDataURL('image/png'),
        width: canvas.width,
        height: canvas.height,
        widthPt: base.width,
        heightPt: base.height,
      });
      // Release the canvas buffer eagerly — a long quote renders many pages.
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    try { await doc.destroy(); } catch { /* already gone */ }
  }
  return pages;
}
