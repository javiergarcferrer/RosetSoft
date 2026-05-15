/**
 * Read a PDF and yield, per page, an array of positioned text items
 * with rotation and font size — these are what the structural parsers
 * rely on to identify banners, table rows, and columns.
 *
 *   item = { str, x, y, w, h, fontSize, rotation, hasEOL, dir }
 *
 *   - origin: top-left, y increases downward
 *   - rotation: 0 (normal), 90 (CCW), -90 (CW), 180 (upside-down)
 */

export async function readPageItems(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent({ includeMarkedContent: false });

  const items = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    if (it.str === ' ') continue;
    const [a, b, , , e, f] = it.transform;
    const x = e;
    const y = viewport.height - f;
    const fontSize = Math.hypot(a, b) || it.height || 10;
    let rotation = 0;
    if (Math.abs(a) < 0.5 && Math.abs(b) > 0.5) rotation = b > 0 ? 90 : -90;
    else if (a < -0.5) rotation = 180;
    items.push({
      str: it.str,
      x,
      y,
      w: it.width || 0,
      h: it.height || fontSize,
      fontSize,
      rotation,
      hasEOL: !!it.hasEOL,
    });
  }
  return { items, width: viewport.width, height: viewport.height, pageNumber };
}

/** Group items into visual "rows" by y proximity, then sort each row by x. */
export function groupRows(items, yTolerance = 2) {
  const upright = items.filter((it) => it.rotation === 0);
  const sorted = [...upright].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= yTolerance) {
      last.items.push(it);
      last.y = (last.y * last.n + it.y) / (last.n + 1);
      last.n += 1;
    } else {
      rows.push({ y: it.y, items: [it], n: 1 });
    }
  }
  rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  return rows;
}

/** Find a row whose first item matches `predicate` and y in [yMin, yMax] (if given). */
export function findRowByLabel(rows, label, { yMin = -Infinity, yMax = Infinity, anchorXMax = 130 } = {}) {
  const re = typeof label === 'string' ? new RegExp(`^${label}$`, 'i') : label;
  return rows.find((r) => r.y >= yMin && r.y <= yMax && r.items.some((it) => it.x < anchorXMax && re.test(it.str.trim())));
}
