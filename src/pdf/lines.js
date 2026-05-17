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
// line.dimensions, line.notes, line.unitPrice.
//
// Furniture-quote tuning: the product image was bumped 48 → 72pt (1.5×) so
// sofas / chairs read as recognizable photos rather than thumbnails. The item
// column gives back ~35pt to absorb the image growth; the spec column gains
// 10pt for richer dimensions/material text; the numeric block was pulled
// slightly left of the right margin to keep ≥18pt gaps between values.
function lineColumns() {
  const right = PAGE_W - MARGIN_R;
  return {
    img:  { x: MARGIN_L + 8,   size: 72 },
    item: { x: MARGIN_L + 92,  w: 165 },
    spec: { x: MARGIN_L + 269, w: 140 },
    qty:  { rightX: right - 130, label: 'CANT.' },
    unit: { rightX: right - 65,  label: 'UNIT.' },
    tot:  { rightX: right - 4,   label: 'TOTAL' },
    itemLabel: 'ARTÍCULO',
    specLabel: 'DETALLE',
  };
}

// Image box (size + 6pt padding from row top) + 6pt below = 84pt minimum row.
const IMAGE_SIZE = 72;
const ROW_MIN_H = IMAGE_SIZE + 12;
const ROW_TOP_PAD = 12;        // innerTop offset (matches the y-from-rowY)
const ROW_BOTTOM_PAD = 6;      // padding below content before the hairline
const SPEC_LINE_H = 11;        // line height for 8.5pt spec text
const SPEC_LINE_H_SMALL = 10;  // line height for 7.5pt description text

/**
 * Word-wrap `text` so each output line fits within `maxWidth` when rendered
 * with `font` at `size`. A single word longer than `maxWidth` is pushed
 * unbroken — the caller asked us not to hide content, so an oversize token
 * overflows visually rather than disappearing.
 */
function wrapToWidth(text, maxWidth, font, size) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(next, size) > maxWidth) {
      if (cur) {
        out.push(cur);
        cur = w;
      } else {
        out.push(w);
        cur = '';
      }
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Spec fields rendered top-to-bottom in the spec column, in order. Returned
 * as an iterable so measure + draw share one source of truth.
 */
function specSegments(line) {
  const segs = [];
  if (line.dimensions) segs.push({ text: line.dimensions, size: 8.5, lh: SPEC_LINE_H,       color: INK_HIGH });
  if (line.description) segs.push({ text: line.description, size: 7.5, lh: SPEC_LINE_H_SMALL, color: INK_SOFT });
  return segs;
}

/** First-spec-line width: capped to leave ~28pt for the qty value + gap. */
function specMaxWidth(cols) {
  return cols.qty.rightX - cols.spec.x - 28;
}

/**
 * How tall this row will render, including dynamic spec-column wrapping.
 * Exposed so the page-break check can decide whether the row fits before
 * we actually draw it.
 */
export function measureLineRowHeight(ctx, line) {
  const { fontRegular } = ctx;
  const cols = lineColumns();
  const maxW = specMaxWidth(cols);

  // Item column depth (measured as pt below rowY, mirroring the draw code).
  let itemDepth = ROW_TOP_PAD;
  if (line.family) itemDepth += 10;
  itemDepth += 12;                       // bold name
  if (line.subtype) itemDepth += 11;
  if (line.reference) itemDepth += 10;
  if (line.notes) itemDepth += 10;

  // Spec column depth — starts at the bold-name baseline.
  let specDepth = ROW_TOP_PAD + (line.family ? 10 : 0);
  for (const seg of specSegments(line)) {
    const lines = wrapToWidth(seg.text, maxW, fontRegular, seg.size);
    specDepth += lines.length * seg.lh;
  }

  // Image footprint: 48pt box + 6pt top padding.
  const imageDepth = 6 + cols.img.size;

  const contentDepth = Math.max(itemDepth, specDepth, imageDepth);
  return Math.max(ROW_MIN_H, contentDepth + ROW_BOTTOM_PAD);
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
 *
 * Row height is dynamic: the spec column wraps to multiple lines if its
 * content overflows the visible width, and the row grows downward to keep
 * the wrapped lines visible. The 48pt image anchors to the top-left.
 */
export async function drawLineRow(page, ctx, cursor, line) {
  const { doc, fontRegular, fontBold, fontItalic } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const innerTop = rowY - ROW_TOP_PAD;

  // Image — anchored to the top of the row (no longer tied to rowH so the
  // image stays put when the spec column grows the row).
  const img = await embedImageById(doc, line.imageId);
  const box = cols.img.size;
  const boxY = rowY - 6 - box;
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
  // The bold name is the visual anchor for the row — spec and numeric columns
  // align to its baseline so the eye reads a clean horizontal band of primary
  // info regardless of whether the optional family/subtype/reference lines fill in.
  let y = innerTop;
  if (line.family) {
    page.drawText(truncate(line.family.toUpperCase(), 24), {
      x: cols.item.x, y, size: 7, font: fontRegular, color: INK_MID, characterSpacing: 1.2,
    });
    y -= 10;
  }
  const nameY = y;
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
    y -= 10;
  }
  const itemBottomY = y;

  // Spec column: wrap each field to multiple lines as needed. The width cap
  // keeps the first line clear of the qty value on the shared baseline;
  // subsequent wrap lines reuse the same width for a clean column edge.
  const specX = cols.spec.x;
  const maxW = specMaxWidth(cols);
  let sy = nameY;
  for (const seg of specSegments(line)) {
    const wrappedLines = wrapToWidth(seg.text, maxW, fontRegular, seg.size);
    for (const ln of wrappedLines) {
      page.drawText(ln, { x: specX, y: sy, size: seg.size, font: fontRegular, color: seg.color });
      sy -= seg.lh;
    }
  }
  const specBottomY = sy;

  // Qty / Unit / Total — aligned with the bold name baseline (same anchor as spec)
  const numY = nameY;
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);
  drawRightAt(page, String(line.qty || 0), cols.qty.rightX, numY, 10, fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(unit, ctx.currency, ctx.rates), cols.unit.rightX, numY, 10, fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(total, ctx.currency, ctx.rates), cols.tot.rightX, numY, 10.5, fontBold, INK);

  // Row bottom: deepest content (item / spec / image) + padding, with a
  // 60pt floor so single-line rows still have visual weight.
  const contentBottomY = Math.min(itemBottomY, specBottomY, boxY);
  const minRowBottom = rowY - ROW_MIN_H;
  const rowBottom = Math.min(minRowBottom, contentBottomY - ROW_BOTTOM_PAD);

  page.drawLine({
    start: { x: MARGIN_L, y: rowBottom },
    end: { x: PAGE_W - MARGIN_R, y: rowBottom },
    thickness: 0.5,
    color: INK_LINE,
  });

  return { x: MARGIN_L, y: rowBottom };
}
