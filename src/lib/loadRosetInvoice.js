/**
 * Browser adapter: read a Ligne Roset INVOICE PDF File into the normalized text
 * items the pure parser (lib/rosetInvoice) consumes, then parse it. Mirrors
 * loadMaterialsPdf.js — pdfjs is dynamically imported so it stays out of the
 * main bundle, and y is flipped to top-down to match the parser's column model.
 */
import { parseRosetInvoice } from './rosetInvoice.js';
import { loadPdfjs } from './loadPdfjs.js';

/**
 * Parse a Roset invoice PDF File into its article lines + furniture subset.
 * @param {File} file
 * @returns {Promise<import('./rosetInvoice.js').ParsedInvoice>}
 */
export async function parseInvoicePdf(file) {
  if (!file) return { lines: [], furniture: [] };
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const items = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewportHeight = page.getViewport({ scale: 1 }).height;
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        const str = (it.str || '').trim();
        if (!str) continue;
        const [, , , , x, y] = it.transform;
        items.push({
          x: Math.round(x * 10) / 10,
          y: Math.round((viewportHeight - y) * 10) / 10, // flip to top-down
          str,
          page: p - 1,
        });
      }
      page.cleanup?.();
    }
  } finally {
    await doc.destroy?.();
  }
  return parseRosetInvoice(items);
}
