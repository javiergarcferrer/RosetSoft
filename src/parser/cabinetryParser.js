/**
 * Cabinetry / dining-tables / non-upholstered products parser.
 *
 * These pages use a fundamentally different layout from upholstered seating:
 *
 *   Top columns (y ≈ 36):
 *     Name | Dimensions | Colors | Reference | USD
 *
 *   For each "item" (dining table, cabinet, chest), there's a block of rows:
 *     - Item title (e.g. "DINING TABLE") at Name column
 *     - Dimensions stacked (H/W/L labels and values) at Dimensions column
 *     - Finish options (e.g. NATURAL OAK, BLACK STAINED OAK) stacked at Colors column,
 *       each with its own reference code (8-digit) and USD price
 *
 *   We yield one variant per finish/reference. The variant name combines the
 *   item title with the finish.
 *
 * Variant pricing here is a single fixed price (priceFixed), not a grade table.
 */

import { groupRows } from './pageReader.js';

const CABINET_COLS = {
  name: { min: 130, max: 200 },
  dimensions: { min: 195, max: 285 },
  colors: { min: 285, max: 480 },
  reference: { min: 480, max: 525 },
  price: { min: 525, max: 595 },
};

const DIM_LABELS = /^(H|W|L|D|S|DIAM\.?|Ø)$/i;

export function isCabinetryPage(items) {
  // Header row at y ≈ 36 must contain "Reference" and "USD" in the right area
  const topRow = items.filter((it) => it.rotation === 0 && it.y < 50);
  const hasRefHeader = topRow.some((it) => /^Reference$/i.test(it.str.trim()) && it.x > 400);
  const hasUsd = topRow.some((it) => /^USD$/i.test(it.str.trim()) && it.x > 480);
  const hasColors = topRow.some((it) => /^Colors$/i.test(it.str.trim()) && it.x > 200);
  return hasRefHeader && hasUsd && hasColors;
}

export function parseCabinetryPage(items) {
  const upright = items.filter((it) => it.rotation === 0);
  const rows = groupRows(upright, 1.2);

  // Skip the column-header row(s) at top
  const dataRows = rows.filter((r) => r.y > 50 && r.y < 800);

  // Identify item-title rows (anchors). A title row has an ALL-CAPS text in the
  // Name column. Each title introduces a new item; finish rows follow.
  const variants = [];
  let currentItem = null;
  // Map of item-y → { dimensions[], finishes[] }
  // We'll attach finishes within ~80 y-units of the title.

  for (const row of dataRows) {
    const xs = row.items;
    const nameItem = xs.find((it) =>
      it.x >= CABINET_COLS.name.min && it.x < CABINET_COLS.name.max &&
      it.fontSize <= 7 &&
      /^[A-Z][A-Z0-9 &./\-]+$/.test(it.str.trim()) &&
      it.str.trim().length >= 3
    );
    const refItem = xs.find((it) =>
      it.x >= CABINET_COLS.reference.min && it.x < CABINET_COLS.reference.max &&
      /^[A-Z0-9]{6,12}$/.test(it.str.trim())
    );
    const priceItem = xs.find((it) =>
      it.x >= CABINET_COLS.price.min && it.x < CABINET_COLS.price.max &&
      /^\d{2,7}$/.test(it.str.trim())
    );
    const colorItem = xs.find((it) =>
      it.x >= CABINET_COLS.colors.min && it.x < CABINET_COLS.colors.max &&
      it.str.trim().length > 0
    );

    // Dimension label/value pair in the dimensions column
    const dimLabel = xs.find((it) =>
      it.x >= CABINET_COLS.dimensions.min && it.x < CABINET_COLS.dimensions.max &&
      DIM_LABELS.test(it.str.trim())
    );
    const dimValue = xs.find((it) =>
      it.x >= CABINET_COLS.dimensions.min + 30 && it.x < CABINET_COLS.dimensions.max + 40 &&
      /^[0-9¾½¼./\- ]+$/.test(it.str.trim()) && it.str.trim().length > 0
    );

    // Start a new item when we see a name-column title
    if (nameItem) {
      currentItem = {
        title: nameItem.str.trim(),
        modelCode: '',
        dimensions: [],
        y: row.y,
      };
      // Check if a model code (e.g. "C 45") is on the next row
    }

    // Capture model code (short alphanumeric like "C 45" near title)
    const modelCodeItem = xs.find((it) =>
      it.x >= CABINET_COLS.name.min && it.x < CABINET_COLS.name.max &&
      /^[A-Z]\s*\d{1,3}$/.test(it.str.trim())
    );
    if (modelCodeItem && currentItem && !currentItem.modelCode) {
      currentItem.modelCode = modelCodeItem.str.replace(/\s+/g, ' ').trim();
    }

    if (dimLabel && dimValue && currentItem) {
      currentItem.dimensions.push(`${dimLabel.str.trim()} ${dimValue.str.trim()}`);
    }

    // Finish/variant row: has reference + price
    if (refItem && priceItem) {
      const finishName = colorItem ? colorItem.str.trim() : '';
      const itemTitle = currentItem ? currentItem.title : '';
      const modelCode = currentItem?.modelCode || '';
      const dimText = currentItem?.dimensions.join(' · ') || '';
      const nameParts = [];
      if (modelCode && modelCode !== itemTitle) nameParts.push(modelCode);
      if (itemTitle) nameParts.push(itemTitle);
      if (finishName && finishName !== itemTitle) nameParts.push(finishName);
      const variantName = nameParts.join(' — ').replace(/\s+/g, ' ').trim();
      variants.push({
        name: variantName || finishName || 'Variant',
        reference: refItem.str.trim(),
        yardage: '',
        dimensions: dimText,
        priceByGrade: {},
        priceFixed: Number(priceItem.str),
      });
    }
  }

  return variants;
}
