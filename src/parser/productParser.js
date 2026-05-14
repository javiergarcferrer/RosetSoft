/**
 * Product page parser.
 *
 * Each product page has a fixed structural pattern:
 *
 *   (description page, if any)
 *     - banner at right or left edge (rotated 90°, size 25)
 *     - designer at top-left (mixed case, plain text)
 *     - year at top-right (4 digits)
 *     - "Important" / "Description" labels
 *     - "Technical impossibilities." label + fabric list below
 *     - CODE label and model code in vertical text near bottom edge
 *
 *   (pricing page — sometimes combined with above)
 *     - variant header row at y ≈ 60 (ALL-CAPS column labels: ARMCHAIR, SOFA, ...)
 *     - secondary sub-headers at y ≈ 78 (e.g. "BASE IN BLACK STAINED ASH")
 *     - tertiary sub-headers at y ≈ 95 (e.g. "1 BACK CUSHION")
 *     - Dimensions row at y ≈ 114, with H/W/D/S labels and values per column
 *     - Yardage row at y ≈ 165 with yardage per column
 *     - Reference row at y ≈ 174 with reference codes per column
 *     - Currency row at y ≈ 182 with "USD" per column
 *     - Grade rows: single letter A-Z at x ≈ 103, prices per variant column
 *
 * Variant columns are anchored by their header x-position. Prices in grade
 * rows are matched to columns by nearest x.
 */

import { groupRows } from './pageReader.js';

const TABLE_LABELS = new Set([
  'name', 'dimensions', 'yardage', 'reference', 'currency',
  'fabrics', 'microfibers', 'leather', 'leathers',
  'important', 'description', 'concept',
]);

const GRADE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * Extract a product banner from a page.
 * The banner is the largest rotated text on the page, with font size ≥ 18,
 * and is not the literal "CODE" label.
 */
export function extractBanner(items) {
  const candidates = items.filter(
    (it) =>
      Math.abs(it.rotation) === 90 &&
      it.fontSize >= 18 &&
      it.str.trim().length > 0 &&
      it.str.trim().toUpperCase() !== 'CODE'
  );
  if (!candidates.length) return null;
  // Pick the largest font, break ties by closer-to-vertical-middle.
  candidates.sort((a, b) => b.fontSize - a.fontSize || a.y - b.y);
  return candidates[0].str.trim();
}

/**
 * Extract the model code (e.g. "133", "12Q"). It's the rotated text near
 * the page edge with smaller font (~14) that appears BELOW the banner and
 * ABOVE a literal "CODE" label.
 */
export function extractModelCode(items) {
  const rotated = items.filter(
    (it) =>
      Math.abs(it.rotation) === 90 &&
      it.fontSize >= 10 &&
      it.fontSize <= 18 &&
      it.str.trim().toUpperCase() !== 'CODE'
  );
  if (!rotated.length) return null;
  // Model code is short alphanumeric, usually 2-4 chars
  const code = rotated
    .map((it) => it.str.trim())
    .find((s) => /^[A-Z0-9]{1,5}$/.test(s));
  return code || null;
}

/** Top-of-page mixed-case proper noun, not a table label.
 *  Designers always sit at y < 45 and x < 200. Two-word names are the norm
 *  ("Pierre Paulin"), occasionally hyphenated or with an accent ("Noé Duchaufour-Lawrance").
 */
const DESIGNER_STOPWORDS = new Set([
  ...['name', 'dimensions', 'yardage', 'reference', 'currency', 'fabrics',
      'microfibers', 'leather', 'leathers', 'important', 'description', 'concept',
      'colors', 'color', 'composition', 'grade', 'wear', 'width', 'price', 'pages',
      'designer', 'page', 'summary'],
]);

export function extractDesigner(rows) {
  for (const row of rows) {
    if (row.y >= 45) continue;
    for (const it of row.items) {
      if (it.x > 280) continue;
      const text = it.str.trim();
      if (!text) continue;
      // Must start with capital
      if (!/^[A-Z]/.test(text)) continue;
      if (text.length < 4 || text.length > 50) continue;
      // Must have at least one lowercase letter
      if (!/[a-zà-ÿ]/.test(text)) continue;
      // Skip table headers (cabinetry pages have "Reference A/B/C/D" at top)
      if (/^Reference\s/i.test(text)) continue;
      if (/^USD\b/i.test(text)) continue;
      const firstWord = text.split(/[\s.]/)[0].toLowerCase();
      if (DESIGNER_STOPWORDS.has(firstWord)) continue;
      if (TABLE_LABELS.has(firstWord)) continue;
      // Allow letters, accented, spaces, common punctuation
      if (!/^[A-Za-zÀ-ÿ' .\-&]{4,50}$/.test(text)) continue;
      return text;
    }
  }
  return '';
}

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

export function extractDescription(rows) {
  const start = rows.findIndex((r) =>
    r.items.some((it) => /^Description$/i.test(it.str.trim()) && it.x < 80)
  );
  if (start < 0) return '';
  const endLabels = /^(Technical impossibilities|CONCEPT)/i;
  const buf = [];
  for (let i = start + 1; i < rows.length; i++) {
    const text = rows[i].items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (rows[i].y > 670) break; // stop near "Technical impossibilities" area
    if (endLabels.test(text)) break;
    if (/^\d{2}\.\d{2}\.\d{4}\/USA/.test(text)) break;
    buf.push(text);
  }
  return buf.join(' ').slice(0, 2000);
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

/**
 * Extract a variant table from a page.
 *
 * Algorithm:
 *  1. Find the Reference row (label "Reference" at x<130). Its 8-digit values
 *     at x>130 give us the column LEFT-edge x-positions.
 *  2. Each column's x range is [anchor[n] - 5, anchor[n+1] - 5).
 *  3. Variant name = ALL-CAPS text at y ≈ headerY in the column's x range.
 *     Sub-rows at headerY+14 / +28 / +42 / +56 are appended.
 *  4. Yardage = the row labeled "Yardage" (at the column's x).
 *  5. Dimensions = H/W/D/S labels and values just below the name row.
 *  6. Prices = single-letter A-Z labels in left column, values in column ranges.
 */
export function extractVariantTable(items) {
  const rows = groupRows(items, 2);

  const nameRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^Name$/i.test(it.str.trim())));
  const refRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^Reference$/i.test(it.str.trim())));
  const yardageRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^Yardage$/i.test(it.str.trim())));
  if (!nameRow || !refRow) return null;

  // Reference cells = the column anchors
  const refCells = refRow.items
    .filter((it) => it.x > 130 && /^\d{6,10}$/.test(it.str.trim()))
    .sort((a, b) => a.x - b.x);

  // Fallback: if no reference codes, use yardage row
  let anchors;
  if (refCells.length) {
    anchors = refCells.map((r) => r.x);
  } else if (yardageRow) {
    const yCells = yardageRow.items
      .filter((it) => it.x > 130 && /\d/.test(it.str))
      .sort((a, b) => a.x - b.x);
    anchors = yCells.map((y) => y.x);
  } else {
    // Last resort: variant header row positions
    const headerCells = items
      .filter((it) => it.rotation === 0 && Math.abs(it.y - nameRow.y) < 4 && it.x > 130)
      .sort((a, b) => a.x - b.x);
    anchors = headerCells.map((h) => h.x);
  }

  if (!anchors.length) return null;

  // Build columns from anchors. Each column n covers [anchor[n] - 10, anchor[n+1] - 10);
  // for the last column we extend to the right of the page.
  const columns = anchors.map((anchorX, i) => {
    const xMin = anchorX - 12;
    const xMax = i < anchors.length - 1 ? (anchors[i + 1] - 12) : Math.max(800, anchorX + 200);
    return { anchor: anchorX, xMin, xMax, name: '', subnames: [] };
  });

  // Variant names: stacked rows starting at nameRow.y, limited to before the dimensions row.
  const dimAnchorRow = rows.find((r) => rowHasLabel(r, /^Dimensions$/i));
  const nameStartY = nameRow.y;
  const nameEndY = dimAnchorRow ? Math.min(dimAnchorRow.y - 4, nameStartY + 40) : nameStartY + 40;
  const nameStackRows = rows.filter((r) => r.y >= nameStartY - 3 && r.y < nameEndY && !isLabelRow(r));
  for (const row of nameStackRows) {
    for (const it of row.items) {
      if (it.x < 130) continue;
      const text = it.str.trim();
      if (!text) continue;
      // Skip single-char dimension labels and dimension-only numerals
      if (/^[HWDST]$/.test(text)) continue;
      if (/^\d{1,3}([.,/¾½¼]\d{1,2})?$/.test(text)) continue;
      const col = findColumn(columns, it.x);
      if (!col) continue;
      if (!col.name) col.name = text;
      else col.subnames.push(text);
    }
  }

  // Dimensions: H/W/D/S labels appear just inside each column anchor; values just to the right of label
  const dimRowsStart = rows.findIndex((r) => rowHasLabel(r, /^Dimensions$/i));
  const dimensions = columns.map(() => []);
  if (dimRowsStart >= 0) {
    for (let i = dimRowsStart; i < Math.min(dimRowsStart + 5, rows.length); i++) {
      const row = rows[i];
      if (i !== dimRowsStart && rowHasAnyLabel(row, [/^Yardage$/i, /^Reference$/i, /^Currency$/i])) break;
      // For each column, find a label H/W/D/S near its anchor and a value to its right (within the same column).
      for (let colIdx = 0; colIdx < columns.length; colIdx++) {
        const col = columns[colIdx];
        const labelItem = row.items.find((it) =>
          /^(?:H|W|D|S|T|DIAM\.?)$/i.test(it.str.trim()) &&
          Math.abs(it.x - col.anchor) < 25
        );
        const valueItem = row.items.find((it) =>
          /^[0-9¾½¼./\- ]+$/.test(it.str.trim()) &&
          it.str.trim().length > 0 &&
          it.x > col.anchor + 10 &&
          it.x < col.xMax
        );
        if (labelItem && valueItem) {
          dimensions[colIdx].push(`${labelItem.str.trim()} ${valueItem.str.trim()}`);
        } else if (valueItem && !labelItem) {
          dimensions[colIdx].push(valueItem.str.trim());
        } else if (labelItem && !valueItem) {
          dimensions[colIdx].push(labelItem.str.trim());
        }
      }
    }
  }

  // Yardage
  const yardages = columns.map((col) => {
    if (!yardageRow) return '';
    const cell = yardageRow.items.find((it) => it.x >= col.xMin && it.x < col.xMax && /\d/.test(it.str));
    return cell ? cell.str.trim() : '';
  });

  // References
  const references = columns.map((col) => {
    const cell = refRow.items.find((it) => it.x >= col.xMin && it.x < col.xMax && /^\d{6,10}$/.test(it.str.trim()));
    return cell ? cell.str.trim() : '';
  });

  // Grade rows
  const priceByVariant = columns.map(() => ({}));
  for (const row of rows) {
    const labelItem = row.items.find((it) => it.x < 130 && it.str.trim().length === 1);
    if (!labelItem) continue;
    const letter = labelItem.str.trim().toUpperCase();
    if (!GRADE_LETTERS.includes(letter)) continue;

    const priceItems = row.items.filter((it) => it.x > 130 && /^\d{1,3}(,\d{3})*$|^\d{2,7}$/.test(it.str.trim()));
    for (const p of priceItems) {
      const idx = columns.findIndex((c) => p.x >= c.xMin && p.x < c.xMax);
      if (idx < 0) continue;
      const val = Number(p.str.replace(/,/g, ''));
      if (Number.isFinite(val) && val > 5 && val < 9999999) {
        priceByVariant[idx][letter] = val;
      }
    }
  }

  // Fixed-price row: some non-upholstered products (STORE LAYOUT, PRADO CADENCE)
  // show prices on a single row between Currency and grade A. Capture as priceFixed.
  const fixedPrices = columns.map(() => null);
  const currencyRow = rows.find((r) => rowHasLabel(r, /^Currency$/i));
  const firstGradeRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^A$/.test(it.str.trim())));
  if (currencyRow && firstGradeRow) {
    const yLo = currencyRow.y + 1;
    const yHi = firstGradeRow.y - 1;
    const candidateItems = items.filter(
      (it) => it.rotation === 0 && it.y > yLo && it.y < yHi && it.x > 130 && /^\d{1,3}(,\d{3})*$|^\d{2,7}$/.test(it.str.trim())
    );
    for (const it of candidateItems) {
      const idx = columns.findIndex((c) => it.x >= c.xMin && it.x < c.xMax);
      if (idx < 0) continue;
      const val = Number(it.str.replace(/,/g, ''));
      if (Number.isFinite(val) && val > 5 && val < 9999999) {
        fixedPrices[idx] = val;
      }
    }
  }

  const variants = columns.map((col, i) => {
    const fullName = [col.name, ...col.subnames].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim();
    return {
      name: fullName || `Variant ${i + 1}`,
      dimensions: dimensions[i].join(' · '),
      yardage: yardages[i],
      reference: references[i],
      priceByGrade: priceByVariant[i],
      priceFixed: fixedPrices[i],
    };
  }).filter((v) => v.reference || v.yardage || Object.keys(v.priceByGrade).length || v.priceFixed != null);

  return { variants };
}

function findColumn(columns, x) {
  // Strict containment first
  const direct = columns.find((c) => x >= c.xMin && x < c.xMax);
  if (direct) return direct;
  // Fallback: snap to the rightmost anchor not greater than x (handles slight left overflow)
  let match = null;
  for (const col of columns) {
    if (col.anchor <= x + 5) match = col;
    else break;
  }
  return match;
}

function isLabelRow(row) {
  return row.items.some((it) => it.x < 130 && TABLE_LABELS.has(it.str.trim().toLowerCase()));
}

function rowHasLabel(row, re) {
  return row.items.some((it) => it.x < 130 && re.test(it.str.trim()));
}

function rowHasAnyLabel(row, regexes) {
  return regexes.some((re) => rowHasLabel(row, re));
}

/** Read up to `count` consecutive lines starting at startY, mapping each line into columns. */
function readMultiLineCells(items, startY, count, columns) {
  const cells = columns.map(() => '');
  for (let i = 0; i < count; i++) {
    const y = startY + i * 7;
    const line = items.filter((it) => it.rotation === 0 && Math.abs(it.y - y) < 4 && it.x > 130);
    for (const col of columns) {
      const colItems = line
        .filter((it) => it.x >= col.xMin && it.x < col.xMax)
        .sort((a, b) => a.x - b.x);
      if (colItems.length) {
        const c = colItems.indexOf(colItems[0]); // unused, just retain order
        const idx = columns.indexOf(col);
        cells[idx] = (cells[idx] + ' ' + colItems.map((it) => it.str.trim()).join(' ')).trim();
      }
    }
  }
  return cells;
}

function readSingleLineCells(items, y, columns, yTol = 5) {
  const cells = columns.map(() => '');
  const line = items.filter((it) => it.rotation === 0 && Math.abs(it.y - y) < yTol && it.x > 130);
  for (const it of line) {
    const idx = columns.findIndex((c) => it.x >= c.xMin && it.x < c.xMax);
    if (idx < 0) continue;
    const text = it.str.trim();
    if (!text) continue;
    cells[idx] = (cells[idx] + ' ' + text).trim();
  }
  return cells;
}
