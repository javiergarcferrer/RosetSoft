// Convert pdf.js text items into the span shape the Python parser expects
// from PyMuPDF's `page.get_text("dict")`.
//
// PyMuPDF span:  { x, y, x1, y1, text, size, font }
//   - x, y    = top-left corner of the glyph box, y INCREASES DOWNWARD from
//               the top of the page (PyMuPDF's convention).
//   - x1, y1  = bottom-right corner.
//   - size    = nominal font size in points.
//
// pdf.js item: { str, transform: [a, b, c, d, e, f], width, height, fontName }
//   - transform places the baseline of the text on the page. The page's PDF
//     coordinate system has y INCREASING UPWARD from the bottom-left.
//   - The width is along the text baseline (post-rotation).
//   - The height is the ascender height in user-space units.
//
// Conversion: top y = (viewport.height - f - height). The original Python
// algorithms reference y-coordinates from the top of the page, so this flip
// is essential.
//
// We expose a single `readPageSpans(page)` that returns the same array shape
// the Python `page_spans()` does, plus a `getTocFromOutline(doc)` that mimics
// `doc.get_toc(simple=False)` by walking the outline tree.

/** Read the page's text content and return PyMuPDF-shaped spans. */
export async function readPageSpans(page) {
  const viewport = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent({ includeMarkedContent: false });
  const spans = [];
  for (const it of tc.items) {
    const text = (it.str || '').trim();
    if (!text) continue;
    const [a, b, , , e, f] = it.transform;
    // Approximate font size from the transform's diagonal.
    const size = Math.hypot(a, b) || it.height || 10;
    // pdf.js transform places the BASELINE at (e, f). Top of the glyph box is
    // baseline minus ascent. The page coordinate frame is bottom-up; flip to
    // top-down so PyMuPDF-shaped consumers see what they expect.
    const baselineY = viewport.height - f;
    const x = e;
    const y = baselineY - (it.height || size);
    const w = it.width || 0;
    spans.push({
      x,
      y,
      x1: x + w,
      y1: baselineY,
      text,
      size,
      font: it.fontName || '',
    });
  }
  return { spans, width: viewport.width, height: viewport.height };
}

/**
 * Read pdf.js outline tree and flatten it to (level, title, page) triples,
 * matching the Python parser's `doc.get_toc(simple=False)` output.
 *
 * pdf.js destinations are arrays whose first element is a page reference.
 * `getPageIndex` resolves it to a 0-based page index; we surface 1-based to
 * stay compatible with the rest of the pipeline.
 */
export async function getTocFromOutline(doc) {
  const outline = await doc.getOutline();
  if (!outline) return [];

  const out = [];

  async function walk(items, level) {
    for (const item of items) {
      let pageNumber = 0;
      const dest = item.dest;
      try {
        let destArr = dest;
        if (typeof destArr === 'string') {
          destArr = await doc.getDestination(destArr);
        }
        if (Array.isArray(destArr) && destArr[0]) {
          const idx = await doc.getPageIndex(destArr[0]);
          pageNumber = idx + 1;
        }
      } catch {
        pageNumber = 0;
      }
      out.push({ level, title: (item.title || '').trim(), page: pageNumber });
      if (item.items?.length) {
        await walk(item.items, level + 1);
      }
    }
  }

  await walk(outline, 1);
  return out;
}
