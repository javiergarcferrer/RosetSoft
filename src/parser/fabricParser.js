/**
 * Fabric / leather page parser.
 *
 * Materials pages have fixed columns at known x-positions:
 *
 *   Name           x ≈ 80-100   (varies by name length, but values land at ~93)
 *   Grade          x ≈ 156-158
 *   Wear (AFNOR)   x ≈ 184      (e.g. "3C", "2C", "3B")
 *   Martindale     x ≈ 180      (e.g. "50000") — appears just below wear
 *   Width          x ≈ 213-216
 *   Price/unit     x ≈ 260-262
 *   Composition    x ≈ 297+
 *
 *   Color list line   x ≈ 68    (e.g. "ANIS:855 NUIT:858 ...")
 *
 * Each material row clusters around a "primary y". Wear/martindale may
 * appear on slightly different y rows but within the same material block.
 */

import { groupRows } from './pageReader.js';

const COLUMN_X = {
  name: { min: 75, max: 135 },
  grade: { min: 145, max: 168 },
  wear: { min: 170, max: 200 },
  width: { min: 205, max: 230 },
  price: { min: 240, max: 280 },
  composition: { min: 285, max: 580 },
};

const COLOR_X_MAX = 80; // colors are at x ≈ 68

export function parseMaterialPage(items, { kind }) {
  const upright = items.filter((it) => it.rotation === 0);
  // Find material "anchor" rows: rows with a name + grade + price near each other.
  // Wear and martindale appear up to ~6 y-units above/below the anchor.
  const rows = groupRows(upright, 1.5).filter((r) => r.y > 60);
  const materials = [];

  let current = null;
  function commit() {
    if (current && current.name) materials.push(current);
    current = null;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const xs = row.items.map((it) => ({ ...it, str: it.str.trim() }));
    const nameItem = xs.find((it) => it.x >= COLUMN_X.name.min && it.x < COLUMN_X.name.max);
    const gradeItem = xs.find((it) => it.x >= COLUMN_X.grade.min && it.x < COLUMN_X.grade.max);
    const widthItem = xs.find((it) => it.x >= COLUMN_X.width.min && it.x < COLUMN_X.width.max);
    const priceItem = xs.find((it) => it.x >= COLUMN_X.price.min && it.x < COLUMN_X.price.max);
    const compositionItems = xs.filter((it) => it.x >= COLUMN_X.composition.min);

    const isNewMaterial =
      nameItem && /^[A-Z][A-Z0-9 .'’&\-/]+( 2| 3)?$/.test(nameItem.str) &&
      gradeItem && /^[A-Z]$/.test(gradeItem.str) &&
      priceItem && /^\d{1,4}$/.test(priceItem.str);

    if (isNewMaterial) {
      commit();
      const compositionText = compositionItems.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      // Look in a y-window of ±8 around the anchor row for wear and martindale.
      const yWindow = upright.filter((it) => Math.abs(it.y - row.y) < 9);
      const wearItem = yWindow.find((it) =>
        it.x >= COLUMN_X.wear.min && it.x < COLUMN_X.wear.max &&
        /^(?:[123][A-C]|S|N\/A)$/i.test(it.str.trim())
      );
      const martindaleItem = yWindow.find((it) =>
        it.x >= COLUMN_X.wear.min && it.x < COLUMN_X.width.min &&
        /^\d{4,7}$/.test(it.str.trim())
      );
      current = {
        kind,
        name: nameItem.str,
        grade: gradeItem.str,
        wear: wearItem ? wearItem.str.trim().toUpperCase() : null,
        martindale: martindaleItem ? Number(martindaleItem.str.trim()) : null,
        width: widthItem ? widthItem.str.replace(/[”"]$/, '') : null,
        pricePerUnit: Number(priceItem.str),
        composition: compositionText,
        colors: [],
        notes: [],
      };
      continue;
    }

    // Composition continuation
    if (current && compositionItems.length && !nameItem) {
      const more = compositionItems.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (more && /\d%|COTTON|WOOL|POLYESTER|VISCOSE|LINEN|ACRYLIC|POLYAMID|MOHAIR|ALPAGA|ELASTHANE|POLYURETHANE|LEATHER/.test(more)) {
        current.composition = (current.composition ? current.composition + ' ' : '') + more;
        continue;
      }
    }

    // Color line
    const text = row.items.map((it) => it.str).join(' ').trim();
    if (current && row.items.length && row.items[0].x < COLOR_X_MAX && /[A-ZÀ-ÿ]:\d{2,5}/.test(text)) {
      const colors = extractColorTokens(text);
      for (const c of colors) {
        const key = c.name + '|' + c.code;
        if (!current.colors.some((x) => x.name + '|' + x.code === key)) current.colors.push(c);
      }
      continue;
    }

    if (current && text && text.length < 350) current.notes.push(text);
  }
  commit();

  return materials;
}

function extractColorTokens(line) {
  // Accept "NAME:CODE" where name can include spaces/letters/numbers and code is digits
  const re = /([A-ZÀ-ŸÉÈÊÁÂÄÔÖÛÜÎÏÇÑ0-9][A-ZÀ-ŸÉÈÊÁÂÄÔÖÛÜÎÏÇÑ0-9 .'’&()\-/]*?):(\d{2,5})\b/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(line)) !== null) {
    const name = m[1].replace(/\s+/g, ' ').trim();
    const code = m[2];
    const key = name + '|' + code;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ name, code });
    }
  }
  return out;
}
