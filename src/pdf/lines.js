import { rgb } from 'pdf-lib';
import { applyLineAdjustments } from '../lib/pricing.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R, CONTENT_W,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, BG_SOFT,
} from './constants.js';
import { drawRightAt, truncate, formatMoney } from './util.js';
import { embedImageById } from './embed.js';

// All x positions absolute; right-aligned columns specify their right edge.
// Header labels need real horizontal gaps between adjacent columns. The
// previous layout had MATLABEL ending ~5pt before CANT. began, so they
// rendered as one run ("TELA / COLORCANT."). We push qty further right and
// shorten the material label to "MATERIAL".
function lineColumns() {
  const right = PAGE_W - MARGIN_R;
  // Column anchors for the line-items table. Positions in absolute x units.
  // The MATERIAL header label is 39pt wide at size-7 with the chosen
  // tracking, so qty.rightX must leave at least ~10pt clearance between
  // (mat.x + MATERIAL_width) and (qty.rightX − CANT_width). With CANT
  // ≈ 21pt wide at size 7, qty.rightX needs to be ≥ mat.x + 39 + 10 + 21
  // = mat.x + 70 — i.e. right − 130 at minimum given mat.x = MARGIN_L+280.
  return {
    img:  { x: MARGIN_L + 8,  size: 48 },
    item: { x: MARGIN_L + 68, w: 200 },
    mat:  { x: MARGIN_L + 280 },
    qty:  { rightX: right - 125, label: 'CANT.' },
    unit: { rightX: right - 65,  label: 'UNIT.' },
    tot:  { rightX: right - 8,   label: 'TOTAL' },
    itemLabel: 'ARTÍCULO',
    matLabel: 'MATERIAL',
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
  // Tracking on the left-aligned labels is kept tight (0.6) — the inter-column
  // gap between MATERIAL and CANT. is only ~10pt at the chosen x positions,
  // and bumping to 1.2 (like the body labels) makes MATERIAL overlap CANT.
  page.drawText(cols.itemLabel, { x: cols.item.x, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
  page.drawText(cols.matLabel, { x: cols.mat.x, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
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
  // Hairline under the dark header band so the empty area reads as a row.
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
 * Render one line item row: product image + name/variant/ref, material
 * swatch + name/color/grade, and right-aligned qty / unit / total.
 */
export async function drawLineRow(page, ctx, cursor, line) {
  const { doc, fontRegular, fontBold } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const rowH = 60;
  const innerTop = rowY - 12;

  // Image: variant > hero > vector
  const imgId = line.variant?.imageId || line.product?.heroImageId || line.product?.vectorImageId;
  const img = await embedImageById(doc, imgId);
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

  // Item: name (bold) / variant (mid) / reference (small mono-ish)
  let y = innerTop;
  page.drawText(truncate(line.product?.name || '(producto)', 34), { x: cols.item.x, y, size: 10.5, font: fontBold, color: INK });
  y -= 13;
  if (line.variant?.name) {
    page.drawText(truncate(line.variant.name, 38), { x: cols.item.x, y, size: 9, font: fontRegular, color: INK_HIGH });
    y -= 11;
  }
  if (line.variant?.reference) {
    page.drawText(line.variant.reference, { x: cols.item.x, y, size: 7.5, font: fontRegular, color: INK_SOFT });
    y -= 10;
  }
  if (line.notes) {
    page.drawText(truncate('Nota: ' + line.notes, 52), { x: cols.item.x, y, size: 7.5, font: ctx.fontItalic, color: INK_MID });
  }

  // Material / color (swatch + text)
  const matX = cols.mat.x;
  const swatch = await embedImageById(doc, line.swatchImageId || line.color?.swatchImageId);
  const swatchBox = 26;
  if (swatch) {
    const scale = Math.min(swatchBox / swatch.width, swatchBox / swatch.height);
    const w = swatch.width * scale;
    const h = swatch.height * scale;
    page.drawRectangle({
      x: matX, y: rowY - 28, width: swatchBox, height: swatchBox,
      color: BG_SOFT, borderColor: INK_LINE, borderWidth: 0.5,
    });
    page.drawImage(swatch, {
      x: matX + (swatchBox - w) / 2,
      y: rowY - 28 + (swatchBox - h) / 2,
      width: w, height: h,
    });
    const tx = matX + swatchBox + 8;
    page.drawText(truncate(line.material?.name || '—', 18), { x: tx, y: innerTop, size: 9.5, font: fontBold, color: INK });
    page.drawText(truncate(line.color?.name || '—', 18), { x: tx, y: innerTop - 11, size: 8.5, font: fontRegular, color: INK_MID });
    if (line.material?.grade) {
      page.drawText(`Grade ${line.material.grade}`, { x: tx, y: innerTop - 22, size: 7.5, font: fontRegular, color: INK_SOFT });
    }
  } else {
    page.drawText(truncate(line.material?.name || 'C.O.M.', 22), { x: matX, y: innerTop, size: 9.5, font: fontBold, color: INK });
    if (line.color?.name) {
      page.drawText(truncate(line.color.name, 22), { x: matX, y: innerTop - 11, size: 8.5, font: fontRegular, color: INK_MID });
    }
    if (line.material?.grade) {
      page.drawText(`Grade ${line.material.grade}`, { x: matX, y: innerTop - 22, size: 7.5, font: fontRegular, color: INK_SOFT });
    }
  }

  // Qty / Unit / Total — vertically centered in the row
  const numY = rowY - 26;
  const unit = applyLineAdjustments(line.basePrice, line.lineMarginPct, line.lineDiscountPct);
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
