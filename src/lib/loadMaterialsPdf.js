/**
 * Browser adapter: read Ligne Roset price-list PDF File(s) into the normalized
 * text items the pure parser (lib/materialsPdf) consumes, then parse them.
 *
 * pdfjs-dist is dynamically imported so it stays out of the main bundle (same
 * pattern as the pdf-lib quote export). pdfjs reports glyph positions with a
 * bottom-left origin; we flip y to top-down so it matches the parser's column
 * model (and the test fixture captured from PyMuPDF).
 *
 * Multiple files are unioned in a single parse: each file's pages get a unique
 * page offset so section tracking and composition wrapping never bleed across
 * files, and the parser's by-name dedupe merges them.
 */
import { parseMaterialsPdf } from './materialsPdf.js';

let workerReady = false;

async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist');
  if (!workerReady) {
    try {
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    } catch {
      // Fall back to the bundled URL form if the ?url import isn't honored.
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
 * Parse one or more price-list PDF files into ParsedPdfMaterial[].
 * @param {File[]|FileList} files
 * @returns {Promise<import('./materialsPdf.js').ParsedPdfMaterial[]>}
 */
export async function parsePriceListPdfs(files) {
  const list = Array.from(files || []);
  if (!list.length) return [];
  const pdfjsLib = await loadPdfjs();

  const items = [];
  let fileIdx = 0;
  for (const file of list) {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const viewportHeight = page.getViewport({ scale: 1 }).height;
        const tc = await page.getTextContent();
        const pageNo = fileIdx * 1000 + (p - 1); // keep files independent
        for (const it of tc.items) {
          const str = (it.str || '').trim();
          if (!str) continue;
          const [, , , , x, y] = it.transform; // [a,b,c,d,e=x,f=y]
          items.push({
            x: Math.round(x * 10) / 10,
            y: Math.round((viewportHeight - y) * 10) / 10, // flip to top-down
            str,
            page: pageNo,
          });
        }
        page.cleanup?.();
      }
    } finally {
      await doc.destroy?.();
    }
    fileIdx += 1;
  }

  return parseMaterialsPdf(items);
}
