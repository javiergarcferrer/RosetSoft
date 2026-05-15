// Cover-materials pages (fabrics / leathers / outdoor fabrics).
//
// The Python parser uses pdfplumber's table extractor, which detects cell
// borders directly from the page's ruled lines. We don't have that, so we
// reconstruct the table from text spans: cluster spans by Y to form rows,
// use the header row to anchor columns, then walk down classifying each
// row as a material row, a colors-line continuation, or a notes line.
//
// Column conventions in the catalog (fabric / outdoor; leather differs):
//
//   NAME   GRADE  WEAR/MARTINDALE  WIDTH  PRICE-PER-YARD  COMPOSITION
//   ↑      ↑      ↑                ↑      ↑               ↑
//   ~93    ~158   ~180 / ~184      ~213   ~262            ~300+
//
// Leather pages swap WIDTH for THICKNESS and PRICE-PER-YARD for PRICE-PER-SM.
//
// Colors row format inside the NAME column:
//
//   ANIS:855 NUIT:858 ECRU:850 ...

import { replacePlaceholders } from './nameFixes.js';

const COLOR_RE = /([A-ZÀ-ÿÉÈÊÁÂÄÔÖÛÜÎÏÇÑ0-9][A-ZÀ-ÿÉÈÊÁÂÄÔÖÛÜÎÏÇÑ0-9 .'’&()\-/]*?):(\d{2,5})\b/g;
const SINGLE_CAP_RE = /^[A-Z]$/;

/**
 * Group every span on the page into rows by Y proximity, then sort each
 * row's spans by X. Tolerance picks neighbouring lines within 1.5 pt.
 */
function groupRows(spans, tol = 1.5) {
  const sorted = spans.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  let cur = null;
  for (const s of sorted) {
    if (!cur || Math.abs(s.y - cur.y) > tol) {
      cur = { y: s.y, items: [s] };
      rows.push(cur);
    } else {
      cur.items.push(s);
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * For each material row, find:
 *  - name      : leftmost token (x ~ 75–135)
 *  - grade     : single uppercase letter at x ~ 145–168
 *  - price     : 1-4 digit number at x ~ 240–280
 *  - wear/mart : 3C-style token + 50000-style number near x ~ 170–200
 *  - width     : numeric at x ~ 205–230
 *  - comp      : everything from x ~ 285 onward
 *
 * Color/notes continuations are rows where only the name column is populated;
 * a colon-and-code pattern signals colors, otherwise we accumulate as notes.
 */
export function parseCoverMaterialsPage(spans, { kind, startId = 1 } = {}) {
  const COL = {
    name:        { min: 75,  max: 138 },
    grade:       { min: 142, max: 168 },
    wear:        { min: 168, max: 205 },
    width:       { min: 205, max: 235 },
    price:       { min: 235, max: 285 },
    composition: { min: 285, max: 580 },
  };

  const rows = groupRows(spans, 1.5).filter((r) => r.y > 60);
  const materials = [];
  let current = null;
  let nextId = startId;

  function commit() {
    if (current && current.name) materials.push(current);
    current = null;
  }

  function findIn(cols, items) {
    return items.find((it) => it.x >= cols.min && it.x < cols.max);
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const items = row.items.map((it) => ({ ...it, text: (it.text || '').trim() }));

    const nameItem = findIn(COL.name, items);
    const gradeItem = findIn(COL.grade, items);
    const widthItem = findIn(COL.width, items);
    const priceItem = findIn(COL.price, items);
    const compItems = items.filter((it) => it.x >= COL.composition.min);

    const isNewMaterial =
      nameItem &&
      /^[A-Z][A-ZÀ-ÿ0-9 .'’&\-/]+( 2| 3)?$/.test(nameItem.text) &&
      gradeItem && SINGLE_CAP_RE.test(gradeItem.text) &&
      priceItem && /^\d{1,4}$/.test(priceItem.text);

    if (isNewMaterial) {
      commit();

      // Wear + Martindale sit within ±9pt of the anchor row in the wear column.
      const yWindow = spans.filter((s) => Math.abs(s.y - row.y) < 9);
      const wearItem = yWindow.find(
        (it) =>
          it.x >= COL.wear.min &&
          it.x < COL.wear.max &&
          /^(?:[123][A-C]|S|N\/A)$/i.test(it.text),
      );
      const martItem = yWindow.find(
        (it) =>
          it.x >= COL.wear.min &&
          it.x < COL.width.min &&
          /^\d{4,7}$/.test(it.text),
      );

      const composition = compItems.map((it) => it.text).join(' ').replace(/\s+/g, ' ').trim();
      current = {
        id: nextId++,
        type: kind,                                  // 'fabric' | 'leather' | 'outdoor-fabric'
        name: replacePlaceholders(nameItem.text),
        grade: gradeItem.text,
        abrasion: wearItem ? wearItem.text.toUpperCase() : null,
        martindale: martItem ? Number(martItem.text) : null,
        width_in: kind === 'leather' ? null : (widthItem ? widthItem.text.replace(/["”]$/, '') : null),
        thickness: kind === 'leather' ? (widthItem ? widthItem.text : null) : null,
        price_per_unit: Number(priceItem.text),
        unit: kind === 'leather' ? 'square meter' : 'yard',
        composition: composition ? replacePlaceholders(composition) : null,
        notes: null,
        colors: [],
      };
      continue;
    }

    if (!current) continue;

    // Composition wrap-around: subsequent rows in the composition column band.
    if (compItems.length && !nameItem) {
      const more = compItems.map((it) => it.text).join(' ').replace(/\s+/g, ' ').trim();
      if (more && /\d%|COTTON|WOOL|POLYESTER|VISCOSE|LINEN|ACRYLIC|POLYAMID|MOHAIR|ALPAGA|ELASTHANE|POLYURETHANE|LEATHER/.test(more)) {
        current.composition = (current.composition ? `${current.composition} ` : '') + replacePlaceholders(more);
        continue;
      }
    }

    // Colors line: the name column carries "NAME:CODE NAME:CODE ..." with x ≈ 68
    const textJoined = items.map((it) => it.text).join(' ').trim();
    const firstIsNameCol = items[0] && items[0].x < 80 && /[A-ZÀ-ÿ]:\d{2,5}/.test(textJoined);
    if (firstIsNameCol) {
      COLOR_RE.lastIndex = 0;
      let m;
      while ((m = COLOR_RE.exec(textJoined)) !== null) {
        const cname = m[1].replace(/\s+/g, ' ').trim();
        const ccode = m[2];
        const dup = current.colors.find((c) => c.name === cname && c.code === ccode);
        if (!dup) {
          current.colors.push({
            name: replacePlaceholders(cname),
            code: ccode,
          });
        }
      }
      continue;
    }

    // Otherwise: notes continuation
    if (textJoined && textJoined.length < 350) {
      current.notes = ((current.notes || '') + ' ' + replacePlaceholders(textJoined)).trim();
    }
  }
  commit();
  return materials;
}
