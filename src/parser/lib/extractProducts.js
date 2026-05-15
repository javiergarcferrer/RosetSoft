// Pull product cards from a product-list page.
//
// Ported from the standalone tarif-parser. Handles both seating (8-digit refs,
// A–Z grade column) and cabinetry (alphanumeric refs, single price) layouts.

import { clusterByKey, parseDimension, parseYardage, parsePrice } from './textUtils.js';

const DIM_LABELS = new Set(['H', 'W', 'D', 'S', 'T', 'L']);

function findReferences(items, kind) {
  const out = [];
  for (const it of items) {
    if (it.rotated) continue;
    const s = it.str.trim();
    if (!s) continue;
    if (kind === 'digit') {
      if (!/^\d{8}$/.test(s)) continue;
      if (it.size < 6.5 || it.size > 9.5) continue;
      out.push({ ...it, ref: s });
    } else {
      if (!/^[0-9A-Z]{6,10}$/.test(s)) continue;
      if (!/[A-Z]/.test(s) || !/\d/.test(s)) continue;
      if (it.size < 4.5 || it.size > 9.5) continue;
      out.push({ ...it, ref: s });
    }
  }
  return out;
}

function buildGradeMap(items, yTop, yBottom) {
  const letters = items.filter(it =>
    !it.rotated &&
    it.size >= 6 && it.size <= 8 &&
    /^[A-Z]$/.test(it.str.trim()) &&
    it.x < 120 &&
    it.y >= yBottom && it.y <= yTop
  );
  if (letters.length < 4) return null;
  const map = new Map();
  const mid = (yTop + yBottom) / 2;
  for (const l of letters) {
    const k = l.str.trim();
    const existing = map.get(k);
    if (!existing || Math.abs(existing.y - mid) > Math.abs(l.y - mid)) {
      map.set(k, { y: l.y });
    }
  }
  return map;
}

function gradeForY(y, gradeMap) {
  if (!gradeMap) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const [letter, info] of gradeMap.entries()) {
    const d = Math.abs(info.y - y);
    if (d < bestDiff) {
      bestDiff = d;
      best = letter;
    }
  }
  return bestDiff < 3.5 ? best : null;
}

function clusterRowsAndCols(refs) {
  const rows = clusterByKey(refs, r => r.y, 6);
  const cols = clusterByKey(refs.map(r => ({ x: r.x })), o => o.x, 10);
  return { rows, cols };
}

function rowBoundaries(rowRefs) {
  const sorted = [...rowRefs].sort((a, b) => a.x - b.x);
  const bounds = [];
  for (let i = 0; i < sorted.length; i++) {
    const ref = sorted[i];
    const left = i === 0 ? 0 : Math.min(ref.x - 15, (sorted[i - 1].x + ref.x) / 2);
    const right = i === sorted.length - 1 ? 700 : sorted[i + 1].x - 2;
    bounds.push({ ref, left, right });
  }
  return bounds;
}

const GUTTER_X_MAX = 110;

function extractDimensions(items, xL, xR, yTop, yBottom) {
  const labelItems = items.filter(it =>
    !it.rotated &&
    it.x >= Math.max(xL, GUTTER_X_MAX) && it.x <= xR &&
    it.y >= yBottom && it.y <= yTop &&
    DIM_LABELS.has(it.str.trim()) &&
    it.size <= 7.5
  );

  const dims = {};
  for (const lab of labelItems) {
    const value = items
      .filter(it =>
        !it.rotated &&
        it.x > lab.x + 2 && it.x <= xR + 5 &&
        Math.abs(it.y - lab.y) < 2 &&
        /[\d¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]/.test(it.str.trim())
      )
      .sort((a, b) => a.x - b.x)
      .map(it => it.str.trim())
      .join(' ')
      .trim();
    if (value) {
      const num = parseDimension(value);
      if (num != null) {
        const key = {
          H: 'height_in',
          W: 'width_in',
          D: 'depth_in',
          S: 'seat_height_in',
          T: 'thickness_in',
          L: 'length_in',
        }[lab.str.trim()];
        if (key && dims[key] == null) dims[key] = num;
      }
    }
  }

  if (Object.keys(dims).length === 0) {
    const inlineItems = items.filter(it =>
      !it.rotated &&
      it.x >= xL && it.x <= xR &&
      it.y >= yBottom && it.y <= yTop &&
      /\/\s*[HWDSLT]/.test(it.str)
    );
    const inline = inlineItems.map(it => it.str).join(' ');
    const re = /\/\s*([HWDSLT])\s*(\d{1,3}(?:[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]|\.\d+)?)/g;
    let m;
    while ((m = re.exec(inline))) {
      const key = {
        H: 'height_in',
        W: 'width_in',
        D: 'depth_in',
        S: 'seat_height_in',
        T: 'thickness_in',
        L: 'length_in',
      }[m[1]];
      const num = parseDimension(m[2]);
      if (key && num != null && num <= 200 && dims[key] == null) dims[key] = num;
    }
  }

  return dims;
}

const HEADER_LABELS = new Set([
  'Name', 'Reference', 'Dimensions', 'Yardage', 'Currency',
  'Fabrics', 'Microfibers', 'Leather', 'CODE', 'USD', 'Colors',
  'Reference A', 'Reference B', 'Reference C', 'Reference D',
]);

function isHeaderToken(s) {
  if (HEADER_LABELS.has(s)) return true;
  if (/^Reference\s+[A-Z]$/.test(s)) return true;
  return false;
}

function isLikelyVariantToken(s) {
  if (!s) return false;
  if (isHeaderToken(s)) return false;
  if (DIM_LABELS.has(s)) return false;
  if (/^[A-Z]$/.test(s)) return false;
  if (parsePrice(s) != null) return false;
  if (parseYardage(s) != null) return false;
  if (/^\d+(?:[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]|\.\d+)?$/.test(s)) return false;
  if (/^[A-Z0-9]{6,10}$/.test(s) && /\d/.test(s)) return false;
  if (!/[A-Z]/.test(s)) return false;
  if (/\/\s*[HWDSLT]\s*\d/.test(s)) return false;
  const alpha = s.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || [];
  if (alpha.length >= 3) {
    const lower = alpha.filter(c => c === c.toLowerCase() && c !== c.toUpperCase()).length;
    if (lower / alpha.length > 0.3) return false;
  }
  return true;
}

function extractVariant(items, xL, xR, yTop, yBottom, refY) {
  const cand = items.filter(it =>
    !it.rotated &&
    it.x >= xL && it.x <= xR &&
    it.y > yBottom && it.y < yTop &&
    Math.abs(it.y - refY) >= 3 &&
    it.size >= 4.5 && it.size <= 7.5 &&
    it.str.trim().length >= 1 &&
    isLikelyVariantToken(it.str.trim())
  );
  if (!cand.length) return { variant_name: null, variant_subtitle: null };

  const lines = clusterByKey(cand, it => it.y, 1.5);
  lines.sort((a, b) => b.key - a.key);

  function joinLine(line) {
    if (!line) return null;
    const parts = line.members
      .sort((a, b) => a.x - b.x)
      .map(m => m.str.trim())
      .filter(s => s && isLikelyVariantToken(s));
    if (!parts.length) return null;
    const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!joined) return null;
    if (/^[A-Z]$/.test(joined)) return null;
    return joined;
  }

  let variant_name = null;
  let variant_subtitle = null;
  for (const ln of lines) {
    const text = joinLine(ln);
    if (!text) continue;
    if (variant_name == null) variant_name = text;
    else if (variant_subtitle == null) { variant_subtitle = text; break; }
  }

  return { variant_name, variant_subtitle };
}

function extractYardage(items, xL, xR, yTop, yBottom) {
  for (const it of items) {
    if (it.rotated) continue;
    if (it.x < xL || it.x > xR) continue;
    if (it.y < yBottom || it.y > yTop) continue;
    const yd = parseYardage(it.str);
    if (yd != null) return yd;
  }
  return null;
}

function extractFinish(items, xL, xR, yTop, yBottom, refY) {
  const cand = items.filter(it =>
    !it.rotated &&
    it.x >= xL && it.x <= xR &&
    Math.abs(it.y - refY) < 2 &&
    it.size <= 7 &&
    /[A-Z]{3,}/.test(it.str) &&
    !/^\d/.test(it.str) &&
    !/USD/.test(it.str)
  );
  if (!cand.length) return null;
  cand.sort((a, b) => a.x - b.x);
  return cand.map(c => c.str.trim()).join(' ').replace(/\s+/g, ' ').trim() || null;
}

function extractPrices(items, refItem, xL, xR, yBottom, gradeMap) {
  const usdAnchor = items.find(it =>
    !it.rotated && it.x >= xL && it.x <= xR &&
    /^USD$/.test(it.str.trim()) &&
    it.y < refItem.y && refItem.y - it.y < 14
  );

  if (!usdAnchor) {
    const sameRow = items.filter(it =>
      !it.rotated &&
      it.x > refItem.x + 5 && it.x <= xR &&
      Math.abs(it.y - refItem.y) < 3 &&
      it.size >= 5 && it.size <= 9 &&
      parsePrice(it.str) != null
    );
    if (sameRow.length) {
      sameRow.sort((a, b) => a.x - b.x);
      return sameRow.map(c => ({ price: parsePrice(c.str), grade: null }));
    }
  }

  const anchorX = usdAnchor ? usdAnchor.x : refItem.x + 40;
  const tolerance = usdAnchor ? 18 : 30;

  const candidates = items.filter(it =>
    !it.rotated &&
    it.x >= xL && it.x <= xR &&
    it.y >= yBottom && it.y < refItem.y - 5 &&
    it.size >= 5 && it.size <= 8 &&
    parsePrice(it.str) != null &&
    Math.abs(it.x - anchorX) <= tolerance
  );

  const out = [];
  for (const c of candidates) {
    out.push({ price: parsePrice(c.str), grade: gradeForY(c.y, gradeMap) });
  }
  out.sort((a, b) => {
    const ag = a.grade ?? 'ZZ';
    const bg = b.grade ?? 'ZZ';
    return ag.localeCompare(bg);
  });
  return out;
}

const NAME_ANCHOR_MAX_GAP = 130;

function splitRowBands(items, rowsOfRefs) {
  const rowYs = rowsOfRefs.map(r => r.members[0].y).sort((a, b) => b - a);

  const nameLabels = items
    .filter(it => !it.rotated && /^Name$/.test(it.str.trim()) && it.size <= 8)
    .map(it => it.y)
    .sort((a, b) => b - a);

  function nearestNameAbove(refY) {
    let best = null;
    for (const y of nameLabels) {
      if (y >= refY + 10 && y <= refY + NAME_ANCHOR_MAX_GAP &&
          (best == null || y < best)) best = y;
    }
    return best;
  }

  const gaps = [];
  for (let i = 1; i < rowYs.length; i++) gaps.push(rowYs[i - 1] - rowYs[i]);
  const median = gaps.length
    ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    : Infinity;
  const isCabinetry = rowYs.length >= 4 && median < 120;

  const bands = [];
  for (let i = 0; i < rowYs.length; i++) {
    const refY = rowYs[i];
    let top, bottom;

    if (isCabinetry) {
      top = i === 0 ? 820 : rowYs[i - 1] - 50;
      bottom = i < rowYs.length - 1 ? rowYs[i + 1] + 8 : 15;
    } else {
      const nameAbove = nearestNameAbove(refY);
      top = nameAbove != null
        ? nameAbove + 8
        : (i === 0 ? 820 : (rowYs[i - 1] + refY) / 2);

      if (i < rowYs.length - 1) {
        const nextNameAbove = nearestNameAbove(rowYs[i + 1]);
        bottom = nextNameAbove != null
          ? nextNameAbove + 8
          : (refY + rowYs[i + 1]) / 2;
      } else {
        bottom = Math.max(15, refY - 280);
      }
    }
    bands.push({ y: refY, top, bottom });
  }
  return bands;
}

export function extractProductsFromPage(items, pageNo, refKind = 'digit') {
  const refs = findReferences(items, refKind);
  if (!refs.length) return [];

  const { rows } = clusterRowsAndCols(refs);
  const bands = splitRowBands(items, rows);

  const products = [];

  for (const band of bands) {
    const inBand = refs.filter(r => Math.abs(r.y - band.y) < 6);
    const boundaries = rowBoundaries(inBand);

    const gradeMap = buildGradeMap(items, band.top, band.bottom);

    for (const { ref, left, right } of boundaries) {
      const variant = extractVariant(items, left, right, band.top, band.bottom, ref.y);
      const dims = extractDimensions(items, left, right, band.top, band.bottom);
      const yardage = extractYardage(items, left, right, band.top, band.bottom);
      const finish = extractFinish(items, left, right, band.top, band.bottom, ref.y);
      const prices = extractPrices(items, ref, left, right, band.bottom, gradeMap);

      let currency = 'USD';
      const curItem = items.find(it =>
        !it.rotated && it.x >= left && it.x <= right &&
        Math.abs(it.y - ref.y) < 12 && /^[A-Z]{3}$/.test(it.str.trim())
      );
      if (curItem && curItem.str.trim() !== 'USD') currency = curItem.str.trim();

      products.push({
        reference: ref.ref,
        variant_name: variant.variant_name,
        variant_subtitle: variant.variant_subtitle,
        ...dims,
        yardage,
        finish,
        currency,
        prices,
        page: pageNo,
        card_x: (left + right) / 2,
        card_y: ref.y,
      });
    }
  }

  return products;
}
