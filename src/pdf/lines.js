import { rgb } from 'pdf-lib';
import { applyLineAdjustments } from '../lib/pricing.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R, CONTENT_W,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, BG_SOFT,
} from './constants.js';
import { drawRightAt, truncate, formatMoney } from './util.js';
import { embedImageById } from './embed.js';

// Column anchors for the line-items table. Lines are user-typed (no catalog
// indirection), so every field below comes straight from the quote_lines row:
// line.imageId, line.family, line.name, line.subtype, line.reference,
// line.dimensions, line.yardage, line.notes, line.unitPrice.
function lineColumns() {
  const right = PAGE_W - MARGIN_R;
  return {
    img:  { x: MARGIN_L + 8,   size: 48 },
    item: { x: MARGIN_L + 68,  w: 200 },
    spec: { x: MARGIN_L + 280, w: 120 },
    qty:  { rightX: right - 125, label: 'CANT.' },
    unit: { rightX: right - 65,  label: 'UNIT.' },
    tot:  { rightX: right - 8,   label: 'TOTAL' },
    itemLabel: 'ARTÍCULO',
    specLabel: 'DETALLE',
  };
}

/** Dark band with the column labels — repeated at the top of every new page. */
export function drawLineHeader(page, ctx, cursor) {
  const { fontBold } = ctx;
  const cols = lineColumns();
  const headerH = 22;
  const y = cursor.y;
  page.drawRectangle({
    x: MARGIN_L, y: y - headerH,
    width: CONTENT_W, height: headerH,
    color: INK,
  });
  const ty = y - 14;
  const labelSize = 7;
  const labelColor = rgb(0.93, 0.92, 0.90);
  page.drawText(cols.itemLabel, { x: cols.item.x, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
  page.drawText(cols.specLabel, { x: cols.spec.x, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
  drawRightAt(page, cols.qty.label, cols.qty.rightX, ty, labelSize, fontBold, labelColor);
  drawRightAt(page, cols.unit.label, cols.unit.rightX, ty, labelSize, fontBold, labelColor);
  drawRightAt(page, cols.tot.label, cols.tot.rightX, ty, labelSize, fontBold, labelColor);
  return { x: MARGIN_L, y: y - headerH - 6 };
}

/**
 * Centered "Sin artículos" placeholder so the totals block doesn't appear to
 * float over empty white space when the quote has no line items yet.
 */
export function drawEmptyLineBody(page, ctx, cursor) {
  const { fontRegular, fontItalic } = ctx;
  const boxH = 56;
  const top = cursor.y;
  const bottom = top - boxH;
  page.drawLine({
    start: { x: MARGIN_L, y: bottom },
    end:   { x: PAGE_W - MARGIN_R, y: bottom },
    thickness: 0.5,
    color: INK_LINE,
  });
  const msg = 'Sin artículos en esta cotización';
  const size = 9.5;
  const w = fontRegular.widthOfTextAtSize(msg, size);
  page.drawText(msg, {
    x: MARGIN_L + (CONTENT_W - w) / 2,
    y: top - (boxH / 2) - 3,
    size,
    font: fontItalic || fontRegular,
    color: INK_SOFT,
  });
  return { x: MARGIN_L, y: bottom };
}

/**
 * Render one line item row. The line carries all of its fields directly —
 * no product/variant/material/color lookups — so this is just text + image
 * placement, no async resolution.
 */
export async function drawLineRow(page, ctx, cursor, line) {
  const { doc, fontRegular, fontBold, fontItalic } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const rowH = 60;
  const innerTop = rowY - 12;

  // Image
  const img = await embedImageById(doc, line.imageId);
  const box = cols.img.size;
  const boxY = rowY - rowH + 6;
  page.drawRectangle({
    x: cols.img.x, y: boxY, width: box, height: box,
    color: BG_SOFT, borderColor: INK_LINE, borderWidth: 0.5,
  });
  if (img) {
    const scale = Math.min(box / img.width, box / img.height) * 0.92;
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: cols.img.x + (box - w) / 2,
      y: boxY + (box - h) / 2,
      width: w, height: h,
    });
  }

  // Item column: family (small caps) / name (bold) / subtype (mid) / reference
  let y = innerTop;
  if (line.family) {
    page.drawText(truncate(line.family.toUpperCase(), 24), {
      x: cols.item.x, y, size: 7, font: fontRegular, color: INK_MID, characterSpacing: 1.2,
    });
    y -= 10;
  }
  page.drawText(truncate(line.name || '(sin nombre)', 34), { x: cols.item.x, y, size: 10.5, font: fontBold, color: INK });
  y -= 12;
  if (line.subtype) {
    page.drawText(truncate(line.subtype, 38), { x: cols.item.x, y, size: 9, font: fontRegular, color: INK_HIGH });
    y -= 11;
  }
  if (line.reference) {
    page.drawText(line.reference, { x: cols.item.x, y, size: 7.5, font: fontRegular, color: INK_SOFT });
    y -= 10;
  }
  if (line.notes) {
    page.drawText(truncate('Nota: ' + line.notes, 52), { x: cols.item.x, y, size: 7.5, font: fontItalic || fontRegular, color: INK_MID });
  }

  // Spec column: dimensions / yardage / description (truncated to one line)
  const specX = cols.spec.x;
  let sy = innerTop;
  if (line.dimensions) {
    page.drawText(truncate(line.dimensions, 22), { x: specX, y: sy, size: 8.5, font: fontRegular, color: INK_HIGH });
    sy -= 11;
  }
  if (line.yardage) {
    page.drawText(truncate(line.yardage, 22), { x: specX, y: sy, size: 8.5, font: fontRegular, color: INK_MID });
    sy -= 11;
  }
  if (line.description) {
    page.drawText(truncate(line.description, 28), { x: specX, y: sy, size: 7.5, font: fontRegular, color: INK_SOFT });
  }

  // Qty / Unit / Total — vertically centered in the row
  const numY = rowY - 26;
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);
  drawRightAt(page, String(line.qty || 0), cols.qty.rightX, numY, 10, fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(unit, ctx.currency, ctx.rates), cols.unit.rightX, numY, 10, fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(total, ctx.currency, ctx.rates), cols.tot.rightX, numY, 10.5, fontBold, INK);

  // Hairline separator
  page.drawLine({
    start: { x: MARGIN_L, y: rowY - rowH },
    end: { x: PAGE_W - MARGIN_R, y: rowY - rowH },
    thickness: 0.5,
    color: INK_LINE,
  });

  return { x: MARGIN_L, y: rowY - rowH };
}
