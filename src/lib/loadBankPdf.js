/**
 * Browser adapter: extract a bank-statement PDF File into the SAME tab/newline-
 * delimited text `parseBankStatement` (lib/accounting/bankStatement) consumes,
 * so dropping the bank's PDF works through the exact CSV/TSV parse path.
 *
 * Mirrors loadRosetInvoice.js — pdfjs is loaded via the shared loadPdfjs()
 * (which goes through safeDynamicImport, so a stale deploy recovers instead of
 * stranding the user). Text items are grouped into rows by their y-position,
 * sorted left-to-right within a row, joined with TAB; rows joined with NEWLINE.
 */
import { loadPdfjs } from './loadPdfjs.js';

// Two text items belong to the same row when their (top-down) y is within this
// many points — absorbs sub-pixel baseline jitter without merging real rows.
const ROW_EPS = 3;

/**
 * @param {File} file
 * @returns {Promise<string>} tab/newline-delimited statement text
 */
export async function bankPdfToText(file) {
  if (!file) return '';
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const out = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewportHeight = page.getViewport({ scale: 1 }).height;
      const tc = await page.getTextContent();

      // Collect positioned text items (robust to missing coordinates).
      const items = [];
      for (const it of tc.items) {
        const str = (it.str || '').trim();
        if (!str) continue;
        const tr = it.transform || [];
        const x = Number.isFinite(tr[4]) ? tr[4] : 0;
        const yRaw = Number.isFinite(tr[5]) ? tr[5] : 0;
        items.push({ x, y: viewportHeight - yRaw, str }); // flip to top-down
      }

      // Group into rows by y, top-down, then sort by x within each row.
      items.sort((a, b) => a.y - b.y || a.x - b.x);
      let curY = null;
      let row = null;
      for (const it of items) {
        if (row && curY != null && Math.abs(it.y - curY) <= ROW_EPS) {
          row.push(it);
        } else {
          if (row) out.push(row);
          row = [it];
          curY = it.y;
        }
      }
      if (row) out.push(row);

      page.cleanup?.();
    }
  } finally {
    await doc.destroy?.();
  }

  return out
    .map((cells) => cells.slice().sort((a, b) => a.x - b.x).map((c) => c.str).join('\t'))
    .join('\n');
}
