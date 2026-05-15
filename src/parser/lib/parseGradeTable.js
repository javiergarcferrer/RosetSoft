// Parse a grade-priced page (sofas, beds, swivel chairs).
//
// Page layout:
//   Top-of-page columns are the VARIANTS. Each column shows a variant name
//   (e.g. "ARMCHAIR PART A", "LOVESEAT HIGH BACK"), its dimensions row,
//   yardage row, an 8-digit reference, then a column of grade-A..Z prices.
//   The gutter column at x < 130 carries the grade-letter labels.
//
// One page can hold 1-2 sub-tables stacked vertically.

import { REF_FULLMATCH } from './refs.js';
import { replacePlaceholders } from './nameFixes.js';

const BAD_TOKENS = new Set([
  'Name', 'Dimensions', 'Yardage', 'Reference', 'Currency', 'USD',
  'Fabrics', 'Microfibers', 'Leather', 'DIAM.',
]);

const SINGLE_LETTER_RE = /^[A-Z]$/;
const DIM_VALUE_RE = /^\d+(?:[¼½¾]?|\.\d+|\s\d\/\d)?["]?$/;
const NUMERIC_PRICE_RE = /^\d{2,6}$/;
const YARDAGE_RE = /yd/;

export function detectGradeTable(spans) {
  const letters = spans.filter((s) => SINGLE_LETTER_RE.test(s.text) && s.x < 130);
  if (letters.length < 8) return false;
  const xs = letters.map((s) => s.x);
  return Math.max(...xs) - Math.min(...xs) < 20;
}

export function clusterRefRows(spans) {
  const refs = spans.filter((s) => REF_FULLMATCH.test(s.text));
  if (!refs.length) return [];
  refs.sort((a, b) => a.y - b.y || a.x - b.x);

  // Cluster by y: spans within 4pt vertically are the same row.
  const groups = [];
  let current = [];
  let lastY = null;
  for (const r of refs) {
    if (lastY == null || Math.abs(r.y - lastY) < 4) {
      current.push(r);
    } else {
      if (current.length) groups.push(current);
      current = [r];
    }
    lastY = r.y;
  }
  if (current.length) groups.push(current);

  const subTables = [];
  for (const g of groups) {
    let colRefs = g.filter((r) => r.x > 80 && r.x < 540);
    if (!colRefs.length) continue;
    colRefs = colRefs.slice().sort((a, b) => a.x - b.x);

    // De-dup by x (same ref text appearing twice at near-same x).
    const clean = [];
    const seenX = [];
    for (const r of colRefs) {
      if (!seenX.length || Math.abs(r.x - seenX[seenX.length - 1]) > 8) {
        clean.push(r);
        seenX.push(r.x);
      }
    }
    subTables.push({
      y: clean.reduce((acc, r) => acc + r.y, 0) / clean.length,
      refs: clean,
      cols_x: clean.map((r) => r.x),
    });
  }
  return subTables;
}

export function parseGradeTablePage(spans, product, pageNo) {
  const subTables = clusterRefRows(spans);
  if (!subTables.length) return [];

  // Map of label name → list of y positions where it appears in the gutter.
  const labelPositions = new Map();
  for (const s of spans) {
    if (
      ['Name', 'Yardage', 'Dimensions', 'Currency', 'Reference'].includes(s.text) &&
      s.x > 80 &&
      s.x < 130
    ) {
      const ys = labelPositions.get(s.text) || [];
      ys.push(s.y);
      labelPositions.set(s.text, ys);
    }
  }
  function nearestLabelY(label, refY, allowAbove = true) {
    const ys = labelPositions.get(label) || [];
    if (!ys.length) return null;
    const cands = allowAbove ? ys.filter((y) => y <= refY + 2) : ys.filter((y) => y >= refY - 2);
    if (!cands.length) return null;
    return allowAbove ? Math.max(...cands) : Math.min(...cands);
  }

  const variants = [];
  for (let ti = 0; ti < subTables.length; ti++) {
    const st = subTables[ti];
    const refY = st.y;
    const colsX = st.cols_x;
    const colsRefs = st.refs;

    const prevSt = ti > 0 ? subTables[ti - 1] : null;
    const nextSt = ti + 1 < subTables.length ? subTables[ti + 1] : null;
    const topBound = prevSt ? prevSt.y + 50 : 50;
    const bottomBound = nextSt ? nextSt.y - 50 : 900;

    const nameY = nearestLabelY('Name', refY, true) ?? topBound;
    const yardageY = nearestLabelY('Yardage', refY, true);
    const dimY = nearestLabelY('Dimensions', refY, true);

    for (let ci = 0; ci < colsX.length; ci++) {
      const refX = colsX[ci];
      const variant = {
        product_id: product.id,
        page: pageNo,
        variant_name: null,
        subtype: null,
        dimensions: {},
        yardage: null,
        reference_code: colsRefs[ci].text.trim(),
        pricing_model: 'grade',
        grade_prices: {},
        color_options: [],
        description: null,
        image_filename: null,
      };

      const leftBound = ci > 0 ? (colsX[ci - 1] + refX) / 2 + 2 : refX - 60;
      const rightBound = ci + 1 < colsX.length ? (colsX[ci + 1] + refX) / 2 - 2 : refX + 60;

      // Variant name: spans between Name-row y and Yardage/ref y, in column band.
      const bandLo = nameY - 2;
      const bandHi = (yardageY ?? refY) - 2;
      const nameSpans = spans
        .filter((s) => {
          if (!(s.y >= bandLo && s.y <= bandHi)) return false;
          if (!(s.x >= leftBound && s.x <= rightBound)) return false;
          if (BAD_TOKENS.has(s.text)) return false;
          if (SINGLE_LETTER_RE.test(s.text)) return false;
          if (/^\d+[¼½¾\d/."' ]*$/.test(s.text)) return false;
          if (YARDAGE_RE.test(s.text)) return false;
          if (REF_FULLMATCH.test(s.text)) return false;
          return true;
        })
        .sort((a, b) => a.y - b.y || a.x - b.x);
      const name = nameSpans
        .map((s) => replacePlaceholders(s.text))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      variant.variant_name = name || null;

      // Dimensions: per-axis labels in the dim band, value just to the right.
      if (dimY != null) {
        const dimBandLo = dimY - 4;
        const dimBandHi = (yardageY ?? refY) - 2;
        for (const axis of ['H', 'W', 'D', 'S', 'L']) {
          const labelSpans = spans.filter(
            (s) =>
              s.y >= dimBandLo &&
              s.y <= dimBandHi &&
              s.x >= leftBound &&
              s.x <= rightBound &&
              s.text === axis,
          );
          for (const ls of labelSpans) {
            const valSpans = spans
              .filter(
                (s) =>
                  Math.abs(s.y - ls.y) < 6 &&
                  s.x > ls.x &&
                  s.x <= ls.x + 120 &&
                  DIM_VALUE_RE.test(s.text),
              )
              .sort((a, b) => a.x - b.x);
            if (valSpans.length) {
              variant.dimensions[axis] = valSpans[0].text;
              break;
            }
          }
        }
      }

      // Yardage.
      if (yardageY != null) {
        const yVals = spans.filter(
          (s) =>
            Math.abs(s.y - yardageY) < 6 &&
            s.x >= leftBound &&
            s.x <= rightBound &&
            YARDAGE_RE.test(s.text),
        );
        if (yVals.length) variant.yardage = yVals[0].text;
      }

      // Grade prices A..Z: gutter rows below the ref, dedup by (letter, y).
      const gradeRows = spans
        .filter(
          (s) =>
            s.y > refY &&
            s.y <= bottomBound &&
            SINGLE_LETTER_RE.test(s.text) &&
            s.x < 130,
        )
        .slice()
        .sort((a, b) => a.y - b.y);
      const seen = new Set();
      for (const gs of gradeRows) {
        const key = `${gs.text}|${gs.y.toFixed(1)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rowVals = spans.filter(
          (s) =>
            Math.abs(s.y - gs.y) < 6 &&
            s.x >= leftBound &&
            s.x <= rightBound &&
            NUMERIC_PRICE_RE.test(s.text),
        );
        if (rowVals.length) {
          const n = Number(rowVals[0].text);
          if (Number.isFinite(n)) variant.grade_prices[gs.text] = n;
        }
      }

      variants.push(variant);
    }
  }

  return variants;
}
