// Variant-table extraction.
//
// A product page can hold up to two stacked tables. Each table is anchored by
// a "Name" label-row at x<130. We detect each table's column anchors by the
// 6-10 digit values on its "Reference" row, then snap every other label and
// value into those columns.

import { groupRows } from './pdf.js';

const TABLE_LABELS = new Set([
  'name', 'dimensions', 'yardage', 'reference', 'currency',
  'fabrics', 'microfibers', 'leather', 'leathers',
  'important', 'description', 'concept',
]);

const GRADE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Find the variant table on the page. A product page can have two stacked
// tables — the upper holds the product's own variants and the lower a
// SHARED accessory list (cushion SKUs that recur on many product pages).
// We only parse the upper table; the lower table is handled implicitly by
// the cushion product's own page (e.g. "CUSHIONS AND CUSHION COVERS").
export function extractAllVariantTables(items) {
  const rows = groupRows(items, 2);
  const nameRows = rows.filter((r) =>
    r.items.some((it) => it.x < 130 && /^Name$/i.test(it.str.trim()))
  );
  if (!nameRows.length) return [];
  const yStart = nameRows[0].y - 5;
  const yEnd = nameRows.length > 1 ? nameRows[1].y - 5 : Infinity;
  const tableRows = rows.filter((r) => r.y >= yStart && r.y < yEnd);
  const tableItems = items.filter((it) => it.rotation === 0 && it.y >= yStart && it.y < yEnd);
  const t = extractOneVariantTable(tableItems, tableRows);
  if (t && t.variants.length) return [{ ...t, yStart, yEnd }];
  return [];
}

function extractOneVariantTable(items, rows) {
  const refRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^Reference$/i.test(it.str.trim())));
  const nameRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^Name$/i.test(it.str.trim())));
  const yardageRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^Yardage$/i.test(it.str.trim())));
  if (!nameRow) return null;

  // Anchors prefer the Reference row's values. Standard upholstered refs
  // are 6-10 digits (e.g. 10003221); composition refs on multi-variant
  // pages can be alphanumeric like "1000X01B".
  const UPHOLSTERED_REF_RE = /^(?:\d{6,10}|[0-9A-Z]{6,12})$/;
  let anchors;
  if (refRow) {
    anchors = refRow.items
      .filter((it) => it.x > 130 && UPHOLSTERED_REF_RE.test(it.str.trim()))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.x);
  }
  if (!anchors || !anchors.length) {
    if (yardageRow) {
      anchors = yardageRow.items
        .filter((it) => it.x > 130 && /\d/.test(it.str))
        .sort((a, b) => a.x - b.x)
        .map((it) => it.x);
    }
  }
  if (!anchors || !anchors.length) {
    // Fallback: variant header items at nameRow.y
    const headerCells = items
      .filter((it) => Math.abs(it.y - nameRow.y) < 4 && it.x > 130)
      .sort((a, b) => a.x - b.x);
    anchors = headerCells.map((h) => h.x);
  }
  if (!anchors.length) return null;

  const columns = anchors.map((anchorX, i) => {
    const xMin = anchorX - 12;
    const xMax = i < anchors.length - 1 ? anchors[i + 1] - 12 : Math.max(800, anchorX + 200);
    return { anchor: anchorX, xMin, xMax, name: '', subnames: [] };
  });

  // Build variant column names from rows between nameRow.y and the dimensions row.
  const dimRow = rows.find((r) => rowHasLabel(r, /^Dimensions$/i));
  const nameStartY = nameRow.y;
  const nameEndY = dimRow ? Math.min(dimRow.y - 4, nameStartY + 40) : nameStartY + 40;
  const nameStackRows = rows.filter((r) => r.y >= nameStartY - 3 && r.y < nameEndY && !isLabelRow(r));
  for (const row of nameStackRows) {
    for (const it of row.items) {
      if (it.x < 130) continue;
      const text = it.str.trim();
      if (!text) continue;
      if (/^[HWDST]$/.test(text)) continue;
      if (/^\d{1,3}([.,/¾½¼]\d{1,2})?$/.test(text)) continue;
      const col = findColumn(columns, it.x);
      if (!col) continue;
      if (!col.name) col.name = text;
      else col.subnames.push(text);
    }
  }

  // Dimensions (multi-row H/W/D/S labels).
  const dimRowsStart = rows.findIndex((r) => rowHasLabel(r, /^Dimensions$/i));
  const dimensions = columns.map(() => []);
  if (dimRowsStart >= 0) {
    for (let i = dimRowsStart; i < Math.min(dimRowsStart + 5, rows.length); i++) {
      const row = rows[i];
      if (i !== dimRowsStart && rowHasAnyLabel(row, [/^Yardage$/i, /^Reference$/i, /^Currency$/i])) break;
      for (let colIdx = 0; colIdx < columns.length; colIdx++) {
        const col = columns[colIdx];
        const labelItem = row.items.find((it) =>
          /^(?:H|W|D|S|T|DIAM\.?)$/i.test(it.str.trim()) && Math.abs(it.x - col.anchor) < 25
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

  // References — same flexible pattern as the anchor detection above.
  const references = columns.map((col) => {
    if (!refRow) return '';
    const cell = refRow.items.find(
      (it) => it.x >= col.xMin && it.x < col.xMax && UPHOLSTERED_REF_RE.test(it.str.trim())
    );
    return cell ? cell.str.trim() : '';
  });

  // Grade prices A..Z
  const priceByVariant = columns.map(() => ({}));
  for (const row of rows) {
    const labelItem = row.items.find((it) => it.x < 130 && it.str.trim().length === 1);
    if (!labelItem) continue;
    const letter = labelItem.str.trim().toUpperCase();
    if (!GRADE_LETTERS.includes(letter)) continue;
    const priceItems = row.items.filter((it) =>
      it.x > 130 && /^\d{1,3}(,\d{3})*$|^\d{2,7}$/.test(it.str.trim())
    );
    for (const p of priceItems) {
      const idx = columns.findIndex((c) => p.x >= c.xMin && p.x < c.xMax);
      if (idx < 0) continue;
      const val = Number(p.str.replace(/,/g, ''));
      if (Number.isFinite(val) && val > 5 && val < 9999999) {
        priceByVariant[idx][letter] = val;
      }
    }
  }

  // Fixed price (between Currency and grade-A rows) for non-upholstered items.
  const fixedPrices = columns.map(() => null);
  const currencyRow = rows.find((r) => rowHasLabel(r, /^Currency$/i));
  const firstGradeRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^A$/.test(it.str.trim())));
  if (currencyRow && firstGradeRow) {
    const yLo = currencyRow.y + 1;
    const yHi = firstGradeRow.y - 1;
    const cands = items.filter((it) =>
      it.rotation === 0 && it.y > yLo && it.y < yHi && it.x > 130 &&
      /^\d{1,3}(,\d{3})*$|^\d{2,7}$/.test(it.str.trim())
    );
    for (const it of cands) {
      const idx = columns.findIndex((c) => it.x >= c.xMin && it.x < c.xMax);
      if (idx < 0) continue;
      const val = Number(it.str.replace(/,/g, ''));
      if (Number.isFinite(val) && val > 5 && val < 9999999) {
        fixedPrices[idx] = val;
      }
    }
  }

  const variants = columns
    .map((col, i) => {
      const fullName = [col.name, ...col.subnames]
        .filter(Boolean)
        .join(' — ')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        name: fullName || `Variant ${i + 1}`,
        dimensions: dimensions[i].join(' · ') || null,
        yardage: yardages[i] || null,
        reference: references[i] || null,
        priceByGrade: priceByVariant[i],
        priceFixed: fixedPrices[i],
      };
    })
    .filter((v) => v.reference || v.yardage || Object.keys(v.priceByGrade).length || v.priceFixed != null);

  return { variants };
}

// Cabinetry / table extractor.
//
// Cabinetry pages have a horizontal header row (Name | Dimensions | Colors |
// Reference | USD or Currency) and one VARIANT PER REFERENCE row.
//
// Three layouts are supported:
//   - Single-product, single-column (ALLUNGAMI): one Reference column at x≈494.
//   - Single-product, multi-column (BOOK&LOOK): 2-4 (Reference, USD) pairs.
//   - Multi-product (e.g. p600 "OTHER OCCASIONAL ITEMS"): page banner is a
//     SECTION name that recurs across many pages; the real product names are
//     SUB-banners (rotated 90°, fs ≈ 8) interleaved with their variants.
//
// The variants array each carry: name, dimensions, material, reference,
// priceFixed, and a `subBanner` field set on multi-product pages so the
// state machine can attribute each variant to the right product.
const BLOCK_GAP_THRESHOLD = 30; // y-units between adjacent ref rows in different blocks
// A Ligne Roset cabinetry reference is 5-13 chars, alphanumeric, and ALWAYS
// contains at least one digit (so we don't pick up column headers like
// "BOTTOM" or "STRUCTURE").
const REF_RE = /^(?=.*\d)[0-9A-Z]{5,13}$/;

export function extractCabinetryTable(items) {
  const upright = items.filter((it) => it.rotation === 0);
  const rows = groupRows(upright, 1.5);

  // Header row: must include at least one "Reference [X]" header and one
  // "USD" or "Currency" header. Three flavours we observe:
  //   - ALLUNGAMI: single Reference column at x≈494, USD at x≈536
  //   - BOOK&LOOK: 4× (Reference, USD) pairs spanning x>200
  //   - LINENS:   single Reference at x≈122, Currency at x≈474
  const headerRow = rows.find(
    (r) =>
      r.y < 50 &&
      r.items.some((it) => /^Reference(\s+[A-Z])?$/i.test(it.str.trim()) && it.x > 80) &&
      r.items.some((it) => /^(USD|Currency)$/i.test(it.str.trim()))
  );
  if (!headerRow) return { variants: [] };

  const refHeaders = headerRow.items
    .filter((it) => /^Reference(\s+[A-Z])?$/i.test(it.str.trim()))
    .sort((a, b) => a.x - b.x);
  const usdHeaders = headerRow.items
    .filter((it) => /^(USD|Currency)$/i.test(it.str.trim()))
    .sort((a, b) => a.x - b.x);

  // Pair each Reference header with the next USD header to its right.
  const colPairs = refHeaders.map((rh) => {
    const usd = usdHeaders.find((u) => u.x > rh.x);
    return { refX: rh.x, usdX: usd ? usd.x : rh.x + 50, label: rh.str.trim() };
  });
  // Establish column right-edges so refs don't bleed into the next column.
  for (let i = 0; i < colPairs.length; i++) {
    const next = colPairs[i + 1];
    colPairs[i].xMax = next ? next.refX - 5 : Math.max(colPairs[i].usdX + 50, 600);
  }

  const dimH = headerRow.items.find((it) => /^Dimensions$/i.test(it.str.trim()));
  const colorsH = headerRow.items.find((it) => /^Colors$/i.test(it.str.trim()));
  const nameH = headerRow.items.find((it) => /^Name$/i.test(it.str.trim()));

  const xCols = {
    name: nameH?.x ?? 145,
    dim: dimH?.x ?? 228,
    colors: colorsH?.x ?? (colPairs[0]?.refX - 200) ?? 292,
    ref: colPairs[0]?.refX ?? 494,
    usd: colPairs[0]?.usdX ?? 536,
  };

  // All reference cells on the page (across every Reference column).
  const refCells = upright
    .filter((it) => {
      if (!REF_RE.test(it.str.trim())) return false;
      // Must fall inside one of the configured column ranges.
      return colPairs.some((c) => it.x >= c.refX - 12 && it.x < (c.refX + (c.usdX - c.refX - 5)));
    })
    .map((it) => ({ ...it, _col: colPairs.findIndex((c) => it.x >= c.refX - 12 && it.x < (c.refX + (c.usdX - c.refX - 5))) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (!refCells.length) return { variants: [] };

  // Per-column configuration names: stacked text items above the first
  // variant row, lying within each column's x range. e.g. "STRUCTURE + TOP",
  // "FOR STACKABLE CHEST", "1 RIGHT DOOR & NICHE AT BOTTOM".
  const firstVariantY = refCells[0].y;
  // Items that LOOK like a dimensions summary "H… / W… / D…". We exclude
  // these from the column-name pickup; they go into colDims separately.
  // Matches a summary like "H41¼ / W20¾ / D17¾" or "/ T0¾ / H91 / D23¼".
  // The string contains AT LEAST 2 dimension labels (H/W/D/S/T) followed by
  // digits, separated by "/". Order is flexible; an optional leading "/"
  // is accepted for layouts that prefix the thickness.
  const dimSummaryRe = /(?:^|\/\s*)[HWDST][\d¾½¼.\s\-]+(?:\/\s*[HWDST][\d¾½¼.\s\-]+)+/i;
  const colNameItems = colPairs.map((c) => {
    const xLo = c.refX - 60;
    const xHi = c.refX + (c.usdX - c.refX);
    return upright
      .filter((it) =>
        it.x >= xLo &&
        it.x < xHi &&
        it.y > headerRow.y + 2 &&
        it.y < firstVariantY - 1 &&
        it.fontSize <= 7 &&
        it.str.trim().length >= 2 &&
        !dimSummaryRe.test(it.str.trim())
      )
      .sort((a, b) => a.y - b.y || a.x - b.x);
  });
  const colNames = colNameItems.map((items) =>
    items.map((it) => it.str.trim()).join(' ').replace(/\s+/g, ' ').trim()
  );

  // Per-column dimensions: an "H… / W… / D…" string sitting between header
  // and first variant row. If no per-column dim line, fall back to the
  // block-level dimensions collection.
  const colDims = colPairs.map((c) => {
    const xLo = c.refX - 80;
    const xHi = c.refX + (c.usdX - c.refX);
    const dimItem = upright.find(
      (it) =>
        it.x >= xLo &&
        it.x < xHi &&
        it.y > headerRow.y + 2 &&
        it.y < firstVariantY - 1 &&
        dimSummaryRe.test(it.str.trim())
    );
    return dimItem ? dimItem.str.trim() : null;
  });

  // Group refs into y-blocks. In a multi-column table each block is a single
  // row (refs at same y across columns); in a single-column table each
  // block spans a few rows of stacked H/W/D/finish text.
  const blocks = [];
  let curBlock = [refCells[0]];
  for (let i = 1; i < refCells.length; i++) {
    if (refCells[i].y - refCells[i - 1].y > BLOCK_GAP_THRESHOLD) {
      blocks.push(curBlock);
      curBlock = [];
    }
    curBlock.push(refCells[i]);
  }
  if (curBlock.length) blocks.push(curBlock);

  // Name-column candidates: text items at x ≈ name column, ALL-CAPS, length
  // ≥ 3. Used for single-column cabinetry block-name detection.
  const nameItems = upright
    .filter((it) =>
      it.x >= xCols.name - 28 &&
      it.x < xCols.dim - 5 &&
      /^[A-Z][A-Z0-9 ./()'’\-]+$/.test(it.str.trim()) &&
      it.str.trim().length >= 3
    )
    .sort((a, b) => a.y - b.y);

  const isMultiCol = colPairs.length >= 2;
  const variants = [];

  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const yLo = block[0].y - 18;
    const yHi = (b + 1 < blocks.length ? blocks[b + 1][0].y : block[block.length - 1].y + 80) - 1;

    // Block-level (= row-level in multi-col) dimensions: union of H/W/D in y range.
    const dims = collectDimensions(upright, xCols.dim, yLo, yHi);

    // Block-level primary + sub names (single-col only).
    const namesInBlock = nameItems.filter((it) => it.y > yLo && it.y <= yHi);
    let blockName = '';
    if (!isMultiCol && namesInBlock.length) {
      const sortedByFs = namesInBlock.slice().sort((a, b) => b.fontSize - a.fontSize || a.y - b.y);
      const primary = sortedByFs[0];
      const lastRefY = block[block.length - 1].y;
      let sub = null;
      for (let i = namesInBlock.length - 1; i >= 0; i--) {
        const it = namesInBlock[i];
        if (it === primary) continue;
        if (it.y < lastRefY) continue;
        sub = it;
        break;
      }
      if (!sub) sub = namesInBlock.find((it) => it !== primary) || null;
      blockName = [primary?.str?.trim(), sub?.str?.trim()]
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .join(' — ');
    }

    // Row-level material (multi-col only): leftmost name-column text at this row's y.
    let rowMaterial = null;
    if (isMultiCol) {
      const blockYMid = block[0].y;
      const cand = upright.find(
        (it) =>
          Math.abs(it.y - blockYMid) < 3 &&
          it.x < colPairs[0].refX - 30 &&
          /^[A-Z][A-Z0-9 .'’&\-/]+$/.test(it.str.trim())
      );
      rowMaterial = cand ? cand.str.trim() : null;
    }

    for (const refCell of block) {
      const ref = refCell.str.trim();
      const colIdx = refCell._col >= 0 ? refCell._col : 0;
      const colPair = colPairs[colIdx];

      // Price: numeric value in this column's USD x range, anywhere within the
      // block's y range. Some layouts (LINENS / Samples) print the price
      // several rows below the ref; multi-column cabinetry prints it on the
      // same row. The block y bounds keep us inside the same variant.
      const priceCands = upright
        .filter((it) =>
          it.y >= yLo &&
          it.y <= yHi &&
          it.x >= colPair.usdX - 12 &&
          it.x < colPair.xMax &&
          /^\d{1,3}(,\d{3})*$|^\d{2,7}$/.test(it.str.trim())
        )
        .sort((a, b) => Math.abs(a.y - refCell.y) - Math.abs(b.y - refCell.y));
      const priceItem = priceCands[0];
      const priceFixed = priceItem ? Number(priceItem.str.replace(/,/g, '')) : null;

      // Material:
      //  - multi-col: row's leftmost-column finish text (already computed).
      //  - single-col: Colors-column text at refCell.y.
      let material;
      if (isMultiCol) {
        material = rowMaterial;
      } else {
        const materialWindow = Math.max(40, colPair.refX - xCols.colors - 20);
        material = findClosestX(upright, xCols.colors, refCell.y, {
          yTol: 3,
          xWindow: materialWindow,
          excludeRefs: true,
        });
      }

      // Name:
      //  - multi-col: column configuration name from above the first variant.
      //  - single-col: block primary + sub.
      const nameValue = isMultiCol ? (colNames[colIdx] || 'Variant') : (blockName || 'Variant');

      // Dimensions:
      //  - multi-col: prefer per-column dim line, else block dims.
      //  - single-col: block dims.
      const dimValue = isMultiCol ? (colDims[colIdx] || dims) : dims;

      // Sub-banner: nearest small rotated banner to refCell.y. May be null
      // on single-product pages where no sub-banner exists.
      const subBanner = findNearestSubBanner(items, refCell.y);
      // Companion description: small upright paragraph text inside the same
      // sub-block. Only meaningful when subBanner != null (multi-product
      // page); we still compute it so the state machine can use it as the
      // sub-banner product's description.
      const subBannerDescription = subBanner
        ? collectBlockDescription(items, refCell.y)
        : null;

      variants.push({
        name: nameValue,
        reference: ref,
        dimensions: dimValue || null,
        material: material || null,
        priceFixed,
        priceByGrade: {},
        yardage: null,
        subBanner,
        subBannerDescription,
      });
    }
  }
  return { variants };
}

// Matches rotated dimension labels like "H 41¼", "W 20¾", "D 17¾"
// that some cabinetry pages print at the page's left edge.
const DIM_LIKE_RE = /^[HWDST]\s*\d/;

// Collect descriptive paragraph text inside a sub-banner block. Roset
// prints product-description paragraphs at fs ≈ 5, rotation 0. Their x
// varies by page layout: usually starting just right of the sub-banner
// column (x ≈ 95..400). We accept any prose-like text (≥ 20 chars,
// contains a lowercase letter and a space) within ~80 y of the ref row.
function collectBlockDescription(items, yAt) {
  const cands = items
    .filter((it) => it.rotation === 0)
    .filter((it) => Math.abs(it.y - yAt) < 90)
    .filter((it) => it.fontSize >= 4 && it.fontSize <= 6)
    .filter((it) => it.x > 95 && it.x < 480)
    .filter((it) => {
      const s = it.str.trim();
      return s.length >= 20 && /[a-zà-ÿ]/.test(s) && /\s/.test(s);
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (!cands.length) return null;
  return cands
    .map((it) => it.str.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 2000);
}

// Find the nearest sub-banner (small rotated text labelling a product within
// a multi-product cabinetry page) to a given y. Roset typically lays the
// sub-banner VERTICALLY CENTERED in its block, so the right answer is the
// nearest-by-distance candidate — not the nearest above.
//
// A candidate is rotated 90°, fs ∈ [7, 13], at x < 150, length ≥ 4, contains
// an A-Z letter, and isn't a stray "H 41¼"-style dimension label.
function findNearestSubBanner(items, yAt) {
  let best = null;
  let bestDist = Infinity;
  for (const it of items) {
    if (Math.abs(it.rotation) !== 90) continue;
    if (it.fontSize < 7 || it.fontSize > 13) continue;
    if (it.x >= 150) continue;
    const s = it.str.trim();
    if (s.length < 4) continue;
    if (!/[A-Z]/.test(s)) continue;
    if (DIM_LIKE_RE.test(s)) continue;
    const dist = Math.abs(it.y - yAt);
    if (dist < bestDist) {
      best = it;
      bestDist = dist;
    }
  }
  return best ? best.str.trim() : null;
}

function findClosestX(items, x, yAt, { yTol = 3, xWindow = 100, excludeRefs = false } = {}) {
  const cands = items
    .filter((it) => Math.abs(it.y - yAt) <= yTol && it.x >= x - 10 && it.x < x + xWindow)
    .filter((it) => it.str.trim().length > 1)
    .filter((it) => !excludeRefs || !REF_RE.test(it.str.trim()))
    .sort((a, b) => Math.abs(a.y - yAt) - Math.abs(b.y - yAt));
  return cands[0]?.str.trim() || null;
}

function collectDimensions(items, xDim, yMin, yMax) {
  // Look in the Dimensions column for items in y∈[yMin, yMax]. Pair labels
  // and values within the same row (labels at fs=6, values at fs=7).
  const inRange = items
    .filter((it) => it.y >= yMin && it.y <= yMax && it.x >= xDim - 30 && it.x < xDim + 100)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of inRange) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= 2.5) {
      last.items.push(it);
      last.y = (last.y + it.y) / 2;
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }
  const parts = [];
  const seen = new Set();
  for (const line of lines) {
    const sorted = line.items.slice().sort((a, b) => a.x - b.x);
    let label = null;
    let value = null;
    for (const it of sorted) {
      const t = it.str.trim();
      if (/^(?:H|W|D|S|T|DIAM\.?)$/i.test(t)) label = t.toUpperCase().replace('.', '');
      else if (/^[0-9¾½¼./\- ]+$/.test(t)) value = t;
    }
    if (label && value && !seen.has(label)) {
      parts.push(`${label} ${value}`);
      seen.add(label);
    }
  }
  return parts.join(' · ') || null;
}

function findColumn(columns, x) {
  const direct = columns.find((c) => x >= c.xMin && x < c.xMax);
  if (direct) return direct;
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
