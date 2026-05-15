// Pull family-level metadata from a family-intro page.
//
// Ported from the standalone tarif-parser. Operates on the `rawItems` shape
// produced by pageClassifier (y increases upward).

import { normalizeText } from './textUtils.js';

function findHeaderY(items, re) {
  for (const it of items) {
    if (it.rotated) continue;
    if (re.test(it.str.trim())) return it.y;
  }
  return null;
}

function collectBand(items, yFrom, yTo, opts = {}) {
  const { xFrom = 0, xTo = Infinity, includeRotated = false, minSize = 0 } = opts;
  const filtered = items.filter(it =>
    (includeRotated || !it.rotated) &&
    it.size >= minSize &&
    it.x >= xFrom && it.x <= xTo &&
    it.y < yFrom && it.y > yTo
  );
  const lines = [];
  for (const it of filtered) {
    let line = lines.find(l => Math.abs(l.y - it.y) < 1.5);
    if (!line) {
      line = { y: it.y, parts: [] };
      lines.push(line);
    }
    line.parts.push(it);
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map(l => {
    l.parts.sort((a, b) => a.x - b.x);
    return l.parts.map(p => p.str).join('').trim();
  }).filter(Boolean).join('\n');
}

const GUTTER_WORDS = new Set([
  'CODE', 'USD', 'EUR', 'GBP', 'CHF', 'AMERICAN', 'EUROPEAN',
  'SUMMARY', 'IMPORTANT',
]);

export function extractFamily(items, pageNo) {
  const titleCand = items
    .filter(it => {
      if (!it.rotated) return false;
      if (it.size < 6) return false;
      const t = it.str.trim();
      if (t.length < 2) return false;
      if (GUTTER_WORDS.has(t)) return false;
      if (!/[A-ZÀ-ÖØ-Þ]/.test(t)) return false;
      if (it.y < 300 || it.y > 760) return false;
      return /^[A-ZÀ-ÖØ-Þ0-9 ®&'\-]+$/.test(t);
    })
    .sort((a, b) => b.width - a.width)[0];
  const name = titleCand?.str.trim() || null;

  let designer = null;
  for (const it of items) {
    if (it.rotated) continue;
    if (it.y > 770 && it.x < 200 && it.size >= 11 && it.size <= 16) {
      const s = it.str.trim();
      if (s && /[A-Za-z]/.test(s) && !/^\d+$/.test(s)) {
        designer = s;
        break;
      }
    }
  }

  let year = null;
  for (const it of items) {
    if (it.rotated) continue;
    if (it.y > 770 && it.x > 400 && /^\d{4}$/.test(it.str.trim())) {
      year = Number(it.str.trim());
      break;
    }
  }

  let code = null;
  const codeLabel = items.find(it => it.rotated && /^CODE$/i.test(it.str.trim()));
  if (codeLabel) {
    const cands = items.filter(it =>
      it.rotated &&
      Math.abs(it.x - codeLabel.x) < 5 &&
      it.y > codeLabel.y + 20 && it.y < codeLabel.y + 200 &&
      /^[A-Z0-9]{2,6}$/.test(it.str.trim())
    );
    cands.sort((a, b) => a.y - b.y);
    if (cands[0]) code = cands[0].str.trim();
  }

  const yDesc = findHeaderY(items, /^Description$/);
  const yImp = findHeaderY(items, /^Important$/);
  const yTech = findHeaderY(items, /^Technical impossibilities\.?$/);
  const yCover = findHeaderY(items, /^List of cover materials/);

  const headerYs = [yDesc, yImp, yTech, yCover].filter(y => y != null);

  function bodyEnd(yStart) {
    const below = headerYs.filter(y => y < yStart).sort((a, b) => b - a);
    return below.length ? below[0] : 30;
  }

  const description = yDesc ? collectBand(items, yDesc - 1, bodyEnd(yDesc), { xFrom: 25, xTo: 540 }) : null;
  const important = yImp ? collectBand(items, yImp - 1, bodyEnd(yImp), { xFrom: 25, xTo: 540 }) : null;
  const technical_impossibilities = yTech
    ? collectBand(items, yTech - 1, bodyEnd(yTech), { xFrom: 25, xTo: 540 })
    : null;
  const cover_materials = yCover
    ? collectBand(items, yCover - 1, bodyEnd(yCover), { xFrom: 25, xTo: 540 })
    : null;

  return {
    name,
    designer,
    year,
    code,
    description: description ? normalizeText(description) : null,
    important: important ? normalizeText(important) : null,
    technical_impossibilities: technical_impossibilities ? normalizeText(technical_impossibilities) : null,
    cover_materials: cover_materials ? normalizeText(cover_materials) : null,
    intro_page: pageNo,
  };
}
