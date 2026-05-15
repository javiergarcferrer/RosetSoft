// Parse a "Reference + price" row-priced page (dining tables, desks, low tables,
// lighting, rugs, accessories, …).
//
// Two structural layouts coexist in this format:
//
//   Layout A — REF on the RIGHT (x > 350)
//     Variant name (e.g. "DINING TABLE") is a section heading at the far left.
//     The heading carries forward across rows until the next heading.
//     Color/finish is a same-row label sitting just left of the ref.
//
//   Layout B — REF on the LEFT (x < 200)
//     Variant name + color/finish are right of the ref, stacked vertically
//     within the same row band.
//
// The price is always the rightmost numeric span within the row's vertical
// band (lighting prices sit 20-40pt below the ref).

import { REF_FULLMATCH, YEAR_RE } from './refs.js';
import { replacePlaceholders } from './nameFixes.js';

const BASE_BAD_TOKENS = new Set([
  'Name', 'Reference', 'USD', 'Dimensions', 'Colors', 'Currency',
  'CODE', 'Yardage', 'Fabrics', 'Microfibers', 'Leather',
]);

const NUMERIC_PRICE_RE = /^\d{2,6}$/;
const HWLDS_RE = /^[HWLDS]$/;
const DIM_VALUE_RE = /^\d+(?:[¼½¾]?|\.\d+)?["]?$/;
const PLAIN_DIM_LIKE_RE = /^\d+[¼½¾\d/."' ]*$/;

export function parseColorTablePage(spans, product, pageNo, { productCode = null } = {}) {
  const refs = spans.filter((s) => REF_FULLMATCH.test(s.text));
  if (!refs.length) return [];

  const bad = new Set(BASE_BAD_TOKENS);
  if (productCode) bad.add(productCode);
  if (product.name_raw) bad.add(product.name_raw);

  // Sort refs by y to compute each row's vertical band (= next ref's y).
  const refsByY = refs.slice().sort((a, b) => a.y - b.y);
  const nextYByIndex = new Map();
  for (let i = 0; i < refsByY.length; i++) {
    nextYByIndex.set(refsByY[i], i + 1 < refsByY.length ? refsByY[i + 1].y : 800);
  }

  const dimLabelSpans = spans.filter((s) => HWLDS_RE.test(s.text));

  // Pre-collect section headers: all-caps short labels at the far left.
  const sectionBad = new Set([...bad, 'USD', 'DIAM.', 'FABRICS', 'MICROFIBERS', 'LEATHER']);
  const sectionHeaders = spans
    .filter((s) => {
      const t = s.text.trim();
      if (s.x >= 200) return false;
      if (!(t.length > 1 && t.length <= 32)) return false;
      if (t.toUpperCase() !== t) return false; // all-caps only
      if (sectionBad.has(t)) return false;
      if (REF_FULLMATCH.test(t)) return false;
      if (HWLDS_RE.test(t)) return false;
      if (PLAIN_DIM_LIKE_RE.test(t)) return false;
      if (YEAR_RE.test(t)) return false;
      return true;
    })
    .slice()
    .sort((a, b) => a.y - b.y);

  function nearestSectionHeader(refY) {
    const same = sectionHeaders.filter((h) => Math.abs(h.y - refY) < 12);
    if (same.length) return same[0].text;
    const above = sectionHeaders.filter((h) => h.y < refY);
    if (above.length) return above[above.length - 1].text;
    return null;
  }

  function isLabelish(t) {
    if (!t || t.length < 2) return false;
    if (bad.has(t)) return false;
    if (REF_FULLMATCH.test(t)) return false;
    if (HWLDS_RE.test(t)) return false;
    if (PLAIN_DIM_LIKE_RE.test(t)) return false;
    if (/^DIAM\.?$/.test(t)) return false;
    if (YEAR_RE.test(t)) return false;
    return true;
  }

  const variants = [];
  for (const r of refs) {
    const refX = r.x;
    const refY = r.y;
    const rowTop = refY - 4;
    const rowBottom = Math.min(nextYByIndex.get(r) - 4, refY + 90);

    // Price column: rightmost numeric span in the row band, x > 380.
    let prices = spans.filter(
      (s) => s.y >= rowTop && s.y <= rowBottom && s.x > 380 && NUMERIC_PRICE_RE.test(s.text),
    );
    if (!prices.length) {
      // Fallback: same-row numeric span anywhere right of the ref.
      prices = spans.filter(
        (s) => Math.abs(s.y - refY) < 6 && s.x > refX && NUMERIC_PRICE_RE.test(s.text),
      );
    }
    if (!prices.length) continue;
    prices = prices.slice().sort((a, b) => b.x - a.x);
    const price = Number(prices[0].text);

    let variantName = null;
    let color = null;
    if (refX > 350) {
      // Layout A
      const sameRow = spans
        .filter((s) => Math.abs(s.y - refY) < 5 && s.x < refX - 4 && isLabelish(s.text))
        .sort((a, b) => refX - a.x - (refX - b.x));
      if (sameRow.length) color = sameRow[0].text;
      variantName = nearestSectionHeader(refY);
    } else {
      // Layout B
      const blockTop = refY - 6;
      const blockBottom = Math.min(nextYByIndex.get(r) - 6, refY + 60);
      const rightLabels = spans
        .filter(
          (s) =>
            s.y >= blockTop &&
            s.y <= blockBottom &&
            s.x >= refX + 4 &&
            s.x <= 460 &&
            isLabelish(s.text),
        )
        .sort((a, b) => a.y - b.y || a.x - b.x);
      // Collapse same-line dupes.
      const seenLines = [];
      for (const s of rightLabels) {
        const prev = seenLines[seenLines.length - 1];
        if (!prev || Math.abs(s.y - prev.y) > 3) {
          seenLines.push(s);
        } else if (s.x < prev.x) {
          seenLines[seenLines.length - 1] = s;
        }
      }
      if (seenLines.length) variantName = seenLines[0].text;
      for (let i = 1; i < seenLines.length; i++) {
        const t = seenLines[i].text;
        if (t && t !== variantName) {
          color = t;
          break;
        }
      }
    }

    // Dimensions: axis labels within ±30pt of the ref's y, value to the right.
    const dimensions = {};
    for (const ls of dimLabelSpans) {
      if (!(ls.y > refY - 30 && ls.y < refY + 30)) continue;
      const axis = ls.text;
      if (dimensions[axis]) continue;
      const valSpans = spans
        .filter(
          (s) =>
            Math.abs(s.y - ls.y) < 6 &&
            s.x > ls.x &&
            s.x <= ls.x + 80 &&
            DIM_VALUE_RE.test(s.text),
        )
        .sort((a, b) => a.x - b.x);
      if (valSpans.length) dimensions[axis] = valSpans[0].text;
    }

    // Per-row description: long-form text between this ref and the next, in
    // the data column area, not a heading.
    const descTop = refY + 8;
    const descBottom = nextYByIndex.get(r) - 8;
    const descSpans = spans.filter((s) => {
      if (!(s.y >= descTop && s.y <= descBottom)) return false;
      const t = s.text;
      if (!t || t.length < 20) return false;
      if (s.x < 50 || s.x > 540) return false;
      if (t.toUpperCase() === t && t.length < 60) return false;
      return true;
    });
    descSpans.sort((a, b) => a.y - b.y || a.x - b.x);
    let description = descSpans
      .map((s) => replacePlaceholders(s.text))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!description) description = null;

    variants.push({
      product_id: product.id,
      page: pageNo,
      variant_name: variantName ? replacePlaceholders(variantName) : null,
      subtype: null,
      dimensions,
      yardage: null,
      reference_code: r.text,
      pricing_model: 'color',
      grade_prices: {},
      color_options: [
        {
          color_or_finish: color ? replacePlaceholders(color) : null,
          reference_code: r.text,
          price_usd: Number.isFinite(price) ? price : null,
        },
      ],
      description,
      image_filename: null,
      _row_y: refY,
    });
  }

  return variants;
}
