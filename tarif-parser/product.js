// Extract product-level fields from a product page: banner name, designer,
// year, description, technical impossibilities, model code.
//
// All x/y values are in viewport units (origin top-left). Table-label items
// always sit at x<130; right-column data lives at x>=130. Banners are
// rotated 90° and live at the far-left page edge.

import { groupRows } from './pdf.js';

// Banner candidate: text item ≥ 18pt, contains an A-Z letter (rules out
// stray "½" / "¼" / "Χ" rendered as rotated dimension marks), at least
// 2 characters, and is NOT the literal "CODE" tag at the page edge.
// We accept BOTH rotated 90° banners (most product pages) AND horizontal
// banners (product front-cards like HÉMICYCLE / MOA at the page top).
function isBannerCandidate(it) {
  if (it.fontSize < 18) return false;
  const s = it.str.trim();
  if (s.length < 2) return false;
  if (!/[A-Z]/.test(s)) return false;
  if (s.toUpperCase() === 'CODE') return false;
  // Rotated 90° banners can sit anywhere on the page.
  if (Math.abs(it.rotation) === 90) return true;
  // Horizontal banners only count at the top of the page.
  if (it.rotation === 0 && it.y < 130 && it.fontSize >= 22) return true;
  return false;
}

// Find the most prominent banner on the page. Rotated banners are preferred
// (they're how Roset marks product pages); horizontal banners are accepted
// for product front-card / description pages.
export function extractBanner(items) {
  const cands = items.filter(isBannerCandidate);
  if (!cands.length) return null;
  cands.sort((a, b) => {
    // Prefer rotated banners over horizontal ones.
    const ar = Math.abs(a.rotation) === 90 ? 1 : 0;
    const br = Math.abs(b.rotation) === 90 ? 1 : 0;
    if (ar !== br) return br - ar;
    // Then by font size (largest first).
    return b.fontSize - a.fontSize || a.y - b.y;
  });
  return cands[0].str.trim();
}

// All banners on the page, sorted top-to-bottom.
export function extractAllBanners(items) {
  return items
    .filter(isBannerCandidate)
    .map((it) => ({ y: it.y, fontSize: it.fontSize, rotation: it.rotation, str: it.str.trim() }))
    .sort((a, b) => a.y - b.y);
}

// Model code: short alphanumeric rotated text below the banner, above the
// literal "CODE" tag at the page foot.
export function extractModelCode(items) {
  const rotated = items.filter(
    (it) =>
      Math.abs(it.rotation) === 90 &&
      it.fontSize >= 10 &&
      it.fontSize <= 18 &&
      it.str.trim().toUpperCase() !== 'CODE'
  );
  for (const it of rotated) {
    const s = it.str.trim();
    if (/^[A-Z0-9]{1,5}$/.test(s)) return s;
  }
  return null;
}

// Designer name. Structural anchor: at the very top of the page (y < 45,
// fs ≥ 11, x < 280), mixed case (must contain at least one lowercase letter),
// and the string must be a plausible human name — letters / spaces / hyphens /
// apostrophes / periods only, 4–50 chars. Table labels printed lower on the
// page (y ≥ 50) and ALL-CAPS sample names (no lowercase letter) never qualify.
export function extractDesigner(rows) {
  for (const row of rows) {
    if (row.y >= 45) continue;
    for (const it of row.items) {
      if (it.x > 280) continue;
      if (it.fontSize < 10) continue;
      const text = it.str.trim();
      if (text.length < 4 || text.length > 50) continue;
      if (!/^[A-Z]/.test(text)) continue;
      if (!/[a-zà-ÿ]/.test(text)) continue;
      if (!/^[A-Za-zÀ-ÿ' .\-&]+$/.test(text)) continue;
      return text;
    }
  }
  return null;
}

// Year: 4 digits in 1900-2099 at top-right.
export function extractYear(rows) {
  for (const row of rows) {
    if (row.y >= 50) continue;
    for (const it of row.items) {
      if (it.x < 400) continue;
      const m = it.str.trim().match(/^(19\d{2}|20\d{2})$/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

// Extract the "Important" section: text between the "Important" section
// header (fs ≥ 10, left margin) and the "Description" header.
// Captures option callouts like "BASE IN EPOXY MATT BLACK LACQUERED STEEL OR
// CHROMED STEEL", composition rules, and add-on references.
export function extractImportant(items, rows) {
  const startIdx = rows.findIndex((r) =>
    r.items.some(
      (it) =>
        it.x < 80 &&
        /^Important$/i.test(it.str.trim()) &&
        // Distinguish the section header (fs≈11) from inline "important :"
        // mentions inside paragraphs (fs≈7).
        it.fontSize >= 9
    )
  );
  if (startIdx < 0) return null;
  const buf = [];
  for (let i = startIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    // Stop at the next major section header.
    const sectionHit = r.items.find(
      (it) =>
        it.x < 80 &&
        it.fontSize >= 9 &&
        /^(?:Description|Concept|Technical impossibilities|Name)\b/i.test(it.str.trim())
    );
    if (sectionHit) break;
    const text = r.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^\d{2}\.\d{2}\.\d{4}\/USA/.test(text)) break;
    if (r.y > 700) break;
    buf.push(text);
  }
  const joined = buf.join('\n').trim();
  return joined.length ? joined.slice(0, 4000) : null;
}

export function extractDescription(rows) {
  // Find the "Description" section header in the left margin (x<80). We
  // bail out before "Technical impossibilities" or a date stamp; we do NOT
  // treat "CONCEPT" / "CONSTRUCTION" / "IMPORTANT" as terminators because
  // they're inline subheadings within the description prose.
  const start = rows.findIndex((r) =>
    r.items.some(
      (it) => it.x < 80 && it.fontSize >= 9 && /^Description$/i.test(it.str.trim())
    )
  );
  if (start < 0) return null;
  const buf = [];
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.y > 700) break;
    const stop = r.items.find(
      (it) => it.x < 80 && it.fontSize >= 9 && /^Technical impossibilities/i.test(it.str.trim())
    );
    if (stop) break;
    const text = r.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^\d{2}\.\d{2}\.\d{4}\/USA/.test(text)) break;
    buf.push(text);
  }
  if (!buf.length) return null;
  return buf.join(' ').slice(0, 4000);
}

export function extractImpossibilities(rows) {
  const idx = rows.findIndex((r) =>
    r.items.some((it) => /^Technical impossibilities/i.test(it.str.trim()) && it.x < 80)
  );
  if (idx < 0) return [];
  const buf = [];
  for (let i = idx + 1; i < rows.length; i++) {
    const text = rows[i].items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^\d{2}\.\d{2}\.\d{4}\/USA/.test(text)) break;
    if (/^Name(\s|$)/i.test(text)) break;
    if (/^Dimensions/i.test(text)) break;
    if (text.length > 600) break;
    buf.push(text);
    if (buf.join(' ').length > 800) break;
  }
  return buf
    .join(' ')
    .split(/[,.]/)
    .map((s) => s.replace(/^\s*and\s+/i, '').trim())
    .filter((s) => /^[A-Z][A-Z0-9/.\-]{1,}( 2)?$/.test(s.replace(/\s+/g, ' ').trim()))
    .map((s) => s.replace(/\s+/g, ' ').trim());
}

// Pull all product-level fields off a single page. Variants are handled
// separately by variant.js — this is the metadata layer.
export function extractProductFields(pageInfo) {
  const { items } = pageInfo;
  const rows = groupRows(items, 2);
  return {
    banner: extractBanner(items),
    banners: extractAllBanners(items),
    designer: extractDesigner(rows),
    year: extractYear(rows),
    description: extractDescription(rows),
    important: extractImportant(items, rows),
    impossibilities: extractImpossibilities(rows),
    modelCode: extractModelCode(items),
  };
}
