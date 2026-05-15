// Cabinetry: a single physical item is sold in 4 size columns (Reference A/B/C/D)
// and several lacquer/finish rows. Each cell is a unique SKU.

import { REF_FULLMATCH } from './refs.js';
import { replacePlaceholders } from './nameFixes.js';

const REF_COL_LABEL_RE = /^Reference\s+([A-Z])$/;

const EXCLUDE_TOKENS_BASE = new Set([
  'Name', 'Reference', 'USD', 'Dimensions', 'Colors', 'Currency',
  'CODE', 'FABRICS', 'MICROFIBERS', 'LEATHER', 'MATT CHROME',
]);

const FINISH_KEYWORDS = [
  'LACQUER', 'WALNUT', 'MARBLE', 'STONEWARE', 'OAK', 'CHERRYWOOD',
  'CHROME', 'ASH', 'CERAMIC', 'PERLE', 'ARGILE', 'PLOMB', 'MOUTARDE',
  'ANTHRACITE', 'BLEU NUIT', 'BRIQUE', 'EBONY',
];

const HWLDS_RE = /^[HWLDS]$/;
const DIM_RE = /^([HWLDS])\s*(\d+[¼½¾]?["]?)$/;
const SIZE_DIM_RE = /^[HWLDS]?\s*\d+(?:[¼½¾]?|\.\d+)?["]?(?:\s*\/\s*\d+(?:[¼½¾]?)?["]?)?$/;
const NUM_ONLY_RE = /^\d+(?:[¼½¾]?|\.\d+)?["]?$/;
const PRICE_RE = /^\d{2,6}$/;

export function parseCabinetryPage(spans, product, pageNo) {
  // 1) Locate the "Reference A/B/C/D" header positions at y < 60.
  const colAnchors = {};
  for (const s of spans) {
    const m = REF_COL_LABEL_RE.exec(s.text);
    if (m && s.y < 60) {
      colAnchors[m[1]] = { x: s.x, y: s.y };
    }
  }
  if (!Object.keys(colAnchors).length) return [];

  const colsSorted = Object.entries(colAnchors).sort((a, b) => a[1].x - b[1].x);
  const colXs = colsSorted.map(([, v]) => v.x);
  const colLetters = colsSorted.map(([k]) => k);

  function colIdxForX(x) {
    for (let i = 0; i < colXs.length; i++) {
      if (Math.abs(x - colXs[i]) < 35) return i;
    }
    return null;
  }

  // 2) For each column, find its size dimension printed just under the
  // "Reference X" header.
  const colSizes = colXs.map(() => ({}));
  for (const s of spans) {
    if (!(s.y > 60 && s.y < 130)) continue;
    if (!(/[HWLDS]\s*\d/.test(s.text) || /\d+[¼½¾]?["]?$/.test(s.text.trim()))) continue;
    const ci = colIdxForX(s.x);
    if (ci == null) continue;
    const m = DIM_RE.exec(s.text.trim());
    if (m) colSizes[ci][m[1]] = m[2];
  }

  // 3) All refs that snap to a column.
  const refs = spans
    .filter((s) => REF_FULLMATCH.test(s.text))
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // 4) Section headers (variant type) — short labels in the left margin.
  const excludeTokens = new Set(EXCLUDE_TOKENS_BASE);
  if (product?.name_raw) excludeTokens.add(product.name_raw);
  if (product?.code) excludeTokens.add(product.code);

  function isHeaderCandidate(s) {
    const t = s.text.trim();
    if (!t || t.length < 2 || t.length > 50) return false;
    if (s.x >= 200) return false;
    if (excludeTokens.has(t)) return false;
    if (REF_FULLMATCH.test(t)) return false;
    if (HWLDS_RE.test(t)) return false;
    if (SIZE_DIM_RE.test(t)) return false;
    if (NUM_ONLY_RE.test(t)) return false;
    if (/^[12]\d{3}$/.test(t)) return false; // year
    const upper = t.toUpperCase();
    if (FINISH_KEYWORDS.some((kw) => upper.includes(kw))) return false;
    if (upper !== t && !/^(?:R |L |Set )/.test(t)) return false;
    return true;
  }

  const headers = spans
    .filter(isHeaderCandidate)
    .slice()
    .sort((a, b) => a.y - b.y);

  function headerFor(y) {
    const same = headers.filter((h) => Math.abs(h.y - y) < 12);
    if (same.length) return same[0].text;
    const below = headers.filter((h) => h.y > y);
    const above = headers.filter((h) => h.y < y);
    if (below.length && (!above.length || below[0].y - y < y - above[above.length - 1].y)) {
      return below[0].text;
    }
    if (above.length) return above[above.length - 1].text;
    return below.length ? below[0].text : null;
  }

  const firstColX = colXs[0];
  const variants = [];

  for (const r of refs) {
    const ci = colIdxForX(r.x);
    if (ci == null) continue;

    // Lacquer label on the same y, left of the first column.
    const finishSpans = spans
      .filter(
        (s) =>
          Math.abs(s.y - r.y) < 5 &&
          s.x < firstColX - 4 &&
          s.x > 30 &&
          s.text &&
          !REF_FULLMATCH.test(s.text) &&
          !NUM_ONLY_RE.test(s.text),
      )
      .sort((a, b) => b.x - a.x); // rightmost first
    const finish = finishSpans.length ? finishSpans[0].text : null;

    // Price: numeric on the same row, 30-100pt right of the ref.
    let price = null;
    const priceCands = spans
      .filter(
        (s) =>
          Math.abs(s.y - r.y) < 5 &&
          s.x > r.x + 30 &&
          s.x < r.x + 100 &&
          PRICE_RE.test(s.text),
      )
      .sort((a, b) => a.x - b.x);
    if (priceCands.length) {
      const n = Number(priceCands[0].text);
      if (Number.isFinite(n)) price = n;
    }

    // Per-column band for row-level dimension fallback.
    const colX = colXs[ci];
    const leftB = ci > 0 ? (colXs[ci - 1] + colX) / 2 : colX - 50;
    const rightB = ci + 1 < colXs.length ? (colXs[ci + 1] + colX) / 2 : colX + 70;

    const dims = { ...colSizes[ci] };
    for (const axis of ['H', 'W', 'D', 'L', 'S']) {
      if (dims[axis]) continue;
      const labelSpans = spans.filter(
        (s) => Math.abs(s.y - r.y) < 5 && s.x >= leftB && s.x <= rightB && s.text === axis,
      );
      for (const ls of labelSpans) {
        const valSpans = spans.filter(
          (s) =>
            Math.abs(s.y - ls.y) < 5 &&
            s.x > ls.x &&
            s.x <= ls.x + 30 &&
            NUM_ONLY_RE.test(s.text),
        );
        if (valSpans.length) {
          dims[axis] = valSpans[0].text;
          break;
        }
      }
    }

    // Per-row description: spans below this row, above the next row, in the
    // finish column area.
    let nextY = null;
    for (const r2 of refs) {
      if (r2.y > r.y + 4) {
        nextY = r2.y;
        break;
      }
    }
    const descBottom = (nextY ?? 800) - 4;
    const descSpans = spans
      .filter(
        (s) =>
          s.y >= r.y + 8 &&
          s.y <= descBottom &&
          s.x > 40 &&
          s.x < 560 &&
          s.text.length >= 20 &&
          s.text.toUpperCase() !== s.text,
      )
      .sort((a, b) => a.y - b.y || a.x - b.x);
    let description = descSpans
      .map((s) => replacePlaceholders(s.text))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!description) description = null;

    variants.push({
      product_id: product.id,
      page: pageNo,
      variant_name: replacePlaceholders(headerFor(r.y) || ''),
      subtype: `col_${colLetters[ci]}`,
      dimensions: dims,
      yardage: null,
      reference_code: r.text,
      pricing_model: 'color',
      grade_prices: {},
      color_options: [
        {
          color_or_finish: finish ? replacePlaceholders(finish) : null,
          reference_code: r.text,
          price_usd: price,
        },
      ],
      description,
      image_filename: null,
      _row_y: r.y,
    });
  }

  return variants;
}
