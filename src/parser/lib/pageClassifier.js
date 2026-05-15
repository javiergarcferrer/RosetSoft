// Classify each page of the catalog as one of:
//   - "family-intro"   : introduces a new family (designer, year, description)
//   - "product-list"   : grid/table of product cards with references
//   - "section-cover"  : section divider (just a heading)
//   - "toc"            : table of contents
//   - "blank"          : page with no meaningful text
//   - "other"          : anything else (cover materials, samples, etc)
//
// Ported from the standalone tarif-parser. Uses raw pdf.js text items so the
// "y increases upward" convention is preserved and downstream extractors
// don't need a translation layer.

export function rawItems(textItems) {
  return textItems.map(it => {
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
    const rotated = Math.abs(a) < 0.01 && Math.abs(d) < 0.01;
    return { str: it.str, x: e, y: f, size, rotated, font: it.fontName, width: it.width };
  });
}

const GUTTER_WORDS = new Set([
  'CODE', 'USD', 'EUR', 'GBP', 'CHF', 'AMERICAN', 'EUROPEAN',
  'SUMMARY', 'IMPORTANT',
]);

export function findFamilyTitle(items) {
  const cands = items.filter(it => {
    if (!it.rotated) return false;
    if (it.size < 6) return false;
    const t = it.str.trim();
    if (t.length < 2 || t.length > 50) return false;
    if (GUTTER_WORDS.has(t)) return false;
    if (!/[A-ZÀ-ÖØ-Þ]/.test(t)) return false;
    if (it.y < 300 || it.y > 760) return false;
    return true;
  });
  if (!cands.length) return null;
  cands.sort((a, b) => b.width - a.width);
  const top = cands[0];
  const ts = top.str.trim();
  if (ts !== ts.toUpperCase()) return null;
  return ts;
}

function hasCodeMarker(items) {
  return items.some(it => it.rotated && /^CODE$/i.test(it.str.trim()));
}

function hasDescriptionLabel(items) {
  return items.some(it => !it.rotated && it.size >= 8 && /^Description$/.test(it.str.trim()));
}

function hasDesignerLine(items) {
  return items.some(it =>
    !it.rotated && it.size >= 11 && it.size <= 16 &&
    it.x < 200 && it.y > 770 &&
    /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(it.str.trim()) &&
    it.str.trim().length >= 3
  );
}

function countDigitRefs(items) {
  let n = 0;
  for (const it of items) {
    if (!it.rotated && it.size >= 7 && it.size <= 9 &&
      /^\d{8}$/.test(it.str.trim())) n++;
  }
  return n;
}

function countAlphaRefs(items) {
  let n = 0;
  for (const it of items) {
    if (!it.rotated && it.size >= 4 && it.size <= 9 &&
      /^[0-9A-Z]{6,10}$/.test(it.str.trim()) &&
      /[A-Z]/.test(it.str) && /\d/.test(it.str)) n++;
  }
  return n;
}

function isSectionCover(items) {
  const meaningful = items.filter(it => it.str.trim().length > 1);
  if (meaningful.length === 0) return false;
  const large = meaningful.filter(it => it.size >= 18);
  return meaningful.length <= 6 && large.length >= 1;
}

function isToc(items) {
  let dotted = 0;
  for (const it of items) {
    if (/\.{6,}/.test(it.str)) dotted++;
  }
  return dotted >= 4;
}

/**
 * @param {Array} textItems raw text items from page.getTextContent().items
 * @returns {{ type: string, items: Array, family?: string, refKind?: 'digit'|'alpha' }}
 */
export function classifyPage(textItems) {
  const items = rawItems(textItems);
  const meaningful = items.filter(it => {
    const s = it.str.trim();
    if (!s) return false;
    if (it.y < 25 && /^\d{1,4}$/.test(s)) return false;
    if (it.y < 30 && /USA|USD|AMERICAN|\d{2}\.\d{2}\.\d{4}/.test(s)) return false;
    return true;
  });

  if (meaningful.length === 0) return { type: 'blank', items };
  if (isToc(meaningful)) return { type: 'toc', items: meaningful };

  const refsDigit = countDigitRefs(meaningful);
  const refsAlpha = countAlphaRefs(meaningful);
  const family = findFamilyTitle(meaningful);
  const description = hasDescriptionLabel(meaningful);
  const designer = hasDesignerLine(meaningful);
  const codeMarker = hasCodeMarker(meaningful);

  if (description && (designer || family) && codeMarker) {
    return { type: 'family-intro', items: meaningful, family };
  }

  if ((refsDigit >= 1 || refsAlpha >= 1) && codeMarker) {
    return {
      type: 'product-list',
      items: meaningful,
      family,
      refKind: refsDigit >= refsAlpha ? 'digit' : 'alpha',
    };
  }

  if (refsDigit >= 3 || refsAlpha >= 3) {
    return {
      type: 'product-list',
      items: meaningful,
      family,
      refKind: refsDigit >= refsAlpha ? 'digit' : 'alpha',
    };
  }

  if (isSectionCover(meaningful)) return { type: 'section-cover', items: meaningful, family };

  return { type: 'other', items: meaningful, family };
}
