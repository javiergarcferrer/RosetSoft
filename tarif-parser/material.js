// Material-page parsers.
//
// The current TARIF format dedicates ONE PAGE per fabric/leather/outdoor-fabric:
// banner = material name; rows = (supplier code, color name, color code).
//
// The legacy format combined multiple materials per page with GRADE + PRICE
// columns. We support both: parseLegacyMaterialPage(items) for the GRADE-based
// table, parseSingleFabricPage(items) for the per-fabric color list.

import { groupRows } from './pdf.js';
import { extractBanner } from './product.js';

// COL definitions for the per-fabric (current) format.
const PER_FABRIC_COLS = {
  supplierCode: { min: 200, max: 270 },
  rosetName:    { min: 270, max: 360 },
  rosetCode:    { min: 360, max: 420 },
};

const PER_FABRIC_HEADER_RE = /\b(SUPPLIER|ROSET\s*NAME|CODE|COLOR\s*CODE)\b/i;

// Parse a per-fabric color list page.
// Returns { name, kind, colors:[{ name, code }] } (composition/grade/etc. null).
export function parseSingleFabricPage(items, { kind = 'fabric' } = {}) {
  const name = extractBanner(items);
  if (!name) return null;
  const upright = items.filter((it) => it.rotation === 0);
  const rows = groupRows(upright, 1.5);
  // Skip header rows (the row containing 'Supplier' or 'Color Code').
  const dataRows = rows.filter((r) => {
    const text = r.items.map((it) => it.str).join(' ');
    if (PER_FABRIC_HEADER_RE.test(text)) return false;
    if (/^\d{1,3}$/.test(text.trim()) && r.y > 700) return false; // page number
    if (/\d{2}\.\d{2}\.\d{4}\/USA/.test(text)) return false;     // footer
    return true;
  });
  const colors = [];
  const seenCodes = new Set();
  for (const row of dataRows) {
    const supplierItem = row.items.find((it) =>
      it.x >= PER_FABRIC_COLS.supplierCode.min && it.x < PER_FABRIC_COLS.supplierCode.max
    );
    const nameItem = row.items.find((it) =>
      it.x >= PER_FABRIC_COLS.rosetName.min && it.x < PER_FABRIC_COLS.rosetName.max
    );
    const codeItem = row.items.find((it) =>
      it.x >= PER_FABRIC_COLS.rosetCode.min && it.x < PER_FABRIC_COLS.rosetCode.max
    );
    if (!nameItem || !codeItem) continue;
    const colorName = nameItem.str.trim();
    const code = codeItem.str.trim();
    if (!colorName || !code) continue;
    if (!/^[0-9A-Za-z]/.test(code)) continue;
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);
    colors.push({ name: colorName, code });
    void supplierItem; // reserved for future supplier-code support
  }
  return {
    kind,
    name: name.replace(/\s+/g, ' ').trim(),
    grade: null,
    composition: null,
    width: null,
    wear: null,
    martindale: null,
    pricePerUnit: null,
    colors,
  };
}

// Parse a legacy GRADE+PRICE materials table (kept for back-compat).
const LEGACY_COLS = {
  name:        { min: 75,  max: 135 },
  grade:       { min: 145, max: 168 },
  wear:        { min: 170, max: 200 },
  width:       { min: 205, max: 230 },
  price:       { min: 240, max: 280 },
  composition: { min: 285, max: 580 },
};

export function parseLegacyMaterialPage(items, { kind = 'fabric' } = {}) {
  const upright = items.filter((it) => it.rotation === 0);
  const rows = groupRows(upright, 1.5).filter((r) => r.y > 60);
  const materials = [];
  let current = null;
  const commit = () => {
    if (current && current.name) materials.push(current);
    current = null;
  };
  for (const row of rows) {
    const xs = row.items.map((it) => ({ ...it, str: it.str.trim() }));
    const nameItem = xs.find((it) => it.x >= LEGACY_COLS.name.min && it.x < LEGACY_COLS.name.max);
    const gradeItem = xs.find((it) => it.x >= LEGACY_COLS.grade.min && it.x < LEGACY_COLS.grade.max);
    const widthItem = xs.find((it) => it.x >= LEGACY_COLS.width.min && it.x < LEGACY_COLS.width.max);
    const priceItem = xs.find((it) => it.x >= LEGACY_COLS.price.min && it.x < LEGACY_COLS.price.max);
    const compItems = xs.filter((it) => it.x >= LEGACY_COLS.composition.min);
    const isAnchor =
      nameItem && /^[A-Z][A-Z0-9 .'’&\-/]+( 2| 3)?$/.test(nameItem.str) &&
      gradeItem && /^[A-Z]$/.test(gradeItem.str) &&
      priceItem && /^\d{1,4}$/.test(priceItem.str);
    if (isAnchor) {
      commit();
      const compText = compItems.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      const yWin = upright.filter((it) => Math.abs(it.y - row.y) < 9);
      const wearItem = yWin.find((it) =>
        it.x >= LEGACY_COLS.wear.min && it.x < LEGACY_COLS.wear.max &&
        /^(?:[123][A-C]|S|N\/A)$/i.test(it.str.trim())
      );
      const martItem = yWin.find((it) =>
        it.x >= LEGACY_COLS.wear.min && it.x < LEGACY_COLS.width.min &&
        /^\d{4,7}$/.test(it.str.trim())
      );
      current = {
        kind,
        name: nameItem.str,
        grade: gradeItem.str,
        wear: wearItem ? wearItem.str.trim().toUpperCase() : null,
        martindale: martItem ? Number(martItem.str.trim()) : null,
        width: widthItem ? widthItem.str.replace(/[”"]$/, '') : null,
        pricePerUnit: Number(priceItem.str),
        composition: compText || null,
        colors: [],
      };
      continue;
    }
    // Composition continuation: any row that lives entirely in the composition
    // column (x ≥ COMPOSITION.min) and that isn't a new material anchor.
    // Position is enough — we don't need to know which fibers exist.
    if (current && compItems.length && !nameItem) {
      const more = compItems.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (more) {
        current.composition = ((current.composition || '') + ' ' + more).trim();
        continue;
      }
    }
    const text = row.items.map((it) => it.str).join(' ').trim();
    if (current && row.items.length && row.items[0].x < 80 && /[A-ZÀ-ÿ]:\d{2,5}/.test(text)) {
      for (const c of extractColorTokens(text)) {
        if (!current.colors.some((x) => x.code === c.code)) current.colors.push(c);
      }
    }
  }
  commit();
  return materials;
}

function extractColorTokens(line) {
  const re = /([A-ZÀ-ŸÉÈÊÁÂÄÔÖÛÜÎÏÇÑ0-9][A-ZÀ-ŸÉÈÊÁÂÄÔÖÛÜÎÏÇÑ0-9 .'’&()\-/]*?):(\d{2,5})\b/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(line)) !== null) {
    const name = m[1].replace(/\s+/g, ' ').trim();
    const code = m[2];
    const key = name + '|' + code;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, code });
  }
  return out;
}
