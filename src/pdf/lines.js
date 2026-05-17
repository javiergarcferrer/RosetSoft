import { rgb } from 'pdf-lib';
import { applyLineAdjustments } from '../lib/pricing.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R, CONTENT_W,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, BG_SOFT,
} from './constants.js';
import { drawRightAt, truncate, formatMoney } from './util.js';
import { embedImageById } from './embed.js';

// ---------------------------------------------------------------------------
// Line-items table geometry.
//
// The row is split into three equal-width sections that sum to CONTENT_W:
//
//   ┌────────────────────────┬────────────────────────┬───────────────────┐
//   │ ARTÍCULO               │ DETALLE                │ CANT. UNIT. TOTAL │
//   │ ┌──────────────────┐   │ H 33 W 30¼ D 32¼       │   1   $4180 $4180 │
//   │ │      image       │   │ Sofá de dos plazas en  │                   │
//   │ │     130×80       │   │ tela. Color a elegir…  │                   │
//   │ └──────────────────┘   │                        │                   │
//   │ AMÉDÉE                 │                        │                   │
//   │ Sofá 2-plazas Pampa    │                        │                   │
//   │ Grade C — PAMPA        │                        │                   │
//   │ 18211150               │                        │                   │
//   └────────────────────────┴────────────────────────┴───────────────────┘
//   56 ←──── ~167pt ─────→ 223 ←──── ~167pt ─────→ 390 ←──── ~167pt ──→ 556
//
// Inside ARTÍCULO the product image stacks on top of the identity text so
// the photo can be wider than the column's text would allow and the name
// still has a sensible wrap target. DETALLE picks up ~75% more usable text
// width than the previous revision — long descriptions now wrap onto two
// lines instead of six. Numeric column gains breathing room between the
// three sub-cells so a 6-digit total never collides with the unit price.
// ---------------------------------------------------------------------------

// Image footprint inside the article column. Cinematic (wider than tall)
// because furniture catalog photos are usually shot in landscape; square
// thumbnails crop the product harder than they need to.
const IMAGE_W = 130;
const IMAGE_H = 80;

const ROW_TOP_PAD = 10;        // distance from rowY (band bottom) to first content
const ROW_BOTTOM_PAD = 8;      // padding below content before the hairline
const IMAGE_TEXT_GAP = 8;      // vertical gap between image and identity text
const SPEC_LINE_H = 11;        // line height for 8.5pt spec text
const SPEC_LINE_H_SMALL = 10;  // line height for 7.5pt description text

// Three equal columns. CONTENT_W is 500pt on US Letter; thirds give 166-167.
function lineColumns() {
  const right = PAGE_W - MARGIN_R;
  const colW = Math.floor(CONTENT_W / 3);

  const article = { x: MARGIN_L,            w: colW };
  const detail  = { x: MARGIN_L + colW,     w: colW };
  const numeric = { x: MARGIN_L + 2 * colW, w: CONTENT_W - 2 * colW };

  // Image centered horizontally inside the article column. The text below
  // it gets the full column width (less small padding) for wrapping, so
  // even long product names land on at most two lines.
  const imgX = article.x + Math.floor((article.w - IMAGE_W) / 2);
  const itemX = article.x + 6;
  const itemW = article.w - 12;

  // Detail column: 8pt left padding for breathing room, full remaining
  // width as the wrap target.
  const specX = detail.x + 8;
  const specW = detail.w - 16;

  // Numeric column: three right-aligned sub-cells. tot.rightX sits 4pt
  // short of the page edge for optical balance with the left margin.
  const qtyRight  = numeric.x + 40;
  const unitRight = numeric.x + 106;
  const totRight  = right - 4;

  return {
    article, detail, numeric,
    img:  { x: imgX, w: IMAGE_W, h: IMAGE_H },
    item: { x: itemX, w: itemW },
    spec: { x: specX, w: specW },
    qty:  { rightX: qtyRight,  label: 'CANT.' },
    unit: { rightX: unitRight, label: 'UNIT.' },
    tot:  { rightX: totRight,  label: 'TOTAL' },
    itemLabel: 'ARTÍCULO',
    specLabel: 'DETALLE',
  };
}

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
 * Detail-column segments rendered top-to-bottom. Returned as an iterable so
 * the measure and draw passes share one source of truth.
 */
function specSegments(line) {
  const segs = [];
  if (line.dimensions) segs.push({ text: line.dimensions, size: 8.5, lh: SPEC_LINE_H,       color: INK_HIGH });
  if (line.description) segs.push({ text: line.description, size: 7.5, lh: SPEC_LINE_H_SMALL, color: INK_SOFT });
  return segs;
}

/**
 * How tall this row will render, including dynamic wrapping in the article
 * (name) and detail (description) columns. Exposed so the page-break check
 * can decide whether the row fits before we actually draw it.
 *
 * Article depth = image height + gap + identity text stack (which itself
 * grows with the wrapped name). Detail depth = description + dimensions
 * wrapped. The row uses the deepest of (article, detail) plus paddings.
 */
export function measureLineRowHeight(ctx, line) {
  const { fontRegular, fontBold } = ctx;
  const cols = lineColumns();

  // Article column — image stacked above identity text.
  let articleDepth = ROW_TOP_PAD + IMAGE_H + IMAGE_TEXT_GAP;
  if (line.family) articleDepth += 10;
  const nameLines = wrapToWidth(line.name || '(sin nombre)', cols.item.w, fontBold, 10.5);
  articleDepth += Math.max(1, nameLines.length) * 12;
  if (line.subtype) {
    const subLines = wrapToWidth(line.subtype, cols.item.w, fontRegular, 9);
    articleDepth += subLines.length * 11;
  }
  if (line.reference) articleDepth += 10;
  if (line.notes) articleDepth += 10;

  // Detail column — wrap every segment to the column width.
  let detailDepth = ROW_TOP_PAD;
  for (const seg of specSegments(line)) {
    const lines = wrapToWidth(seg.text, cols.spec.w, fontRegular, seg.size);
    detailDepth += lines.length * seg.lh;
  }

  const contentDepth = Math.max(articleDepth, detailDepth);
  // Floor at one image's worth of height so a row with no description or
  // identity text still has visual weight.
  const minRow = ROW_TOP_PAD + IMAGE_H + IMAGE_TEXT_GAP + 20 + ROW_BOTTOM_PAD;
  return Math.max(minRow, contentDepth + ROW_BOTTOM_PAD);
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
  // ARTÍCULO label aligns with the identity text below the image (not the
  // image's centered x) so the column header tracks with where the eye
  // actually scans for the product name.
  page.drawText(cols.itemLabel, { x: cols.item.x, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
  page.drawText(cols.specLabel, { x: cols.spec.x, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
  drawRightAt(page, cols.qty.label,  cols.qty.rightX,  ty, labelSize, fontBold, labelColor);
  drawRightAt(page, cols.unit.label, cols.unit.rightX, ty, labelSize, fontBold, labelColor);
  drawRightAt(page, cols.tot.label,  cols.tot.rightX,  ty, labelSize, fontBold, labelColor);
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
 * Render one line item row. Lines carry all of their fields directly (no
 * catalog lookups) so this is text + image placement, no async resolve.
 *
 * Layout per column:
 *   - ARTÍCULO: cinematic image up top, identity text below
 *   - DETALLE:  dimensions + description, top-aligned with image top
 *   - Numeric:  qty / unit / total on a single horizontal grid line near
 *     the top of the row (aligned with the image's vertical center)
 */
export async function drawLineRow(page, ctx, cursor, line) {
  const { doc, fontRegular, fontBold, fontItalic } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;

  // Image — top-centre of the article column. The placeholder rectangle is
  // drawn unconditionally so empty-image rows still show their slot rather
  // than collapsing to white space (which would visually misalign the row
  // against neighbours that DO have images).
  const img = await embedImageById(doc, line.imageId);
  const boxX = cols.img.x;
  const boxTop = rowY - ROW_TOP_PAD;
  const boxY = boxTop - cols.img.h;
  page.drawRectangle({
    x: boxX, y: boxY, width: cols.img.w, height: cols.img.h,
    color: BG_SOFT, borderColor: INK_LINE, borderWidth: 0.5,
  });
  if (img) {
    // 0.94 contain-scale leaves a thin matte around the photo so it doesn't
    // touch the box border (reads as intentional, not clipped).
    const scale = Math.min(cols.img.w / img.width, cols.img.h / img.height) * 0.94;
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: boxX + (cols.img.w - w) / 2,
      y: boxY + (cols.img.h - h) / 2,
      width: w, height: h,
    });
  }

  // Identity text — stacked under the image, full column width as the
  // wrap target. Family / Name (bold) / Subtype / Reference / Notes.
  let y = boxY - IMAGE_TEXT_GAP;
  if (line.family) {
    page.drawText(truncate(line.family.toUpperCase(), 32), {
      x: cols.item.x, y, size: 7, font: fontRegular, color: INK_MID, characterSpacing: 1.2,
    });
    y -= 10;
  }
  const nameLines = wrapToWidth(line.name || '(sin nombre)', cols.item.w, fontBold, 10.5);
  for (const ln of nameLines) {
    page.drawText(ln, { x: cols.item.x, y, size: 10.5, font: fontBold, color: INK });
    y -= 12;
  }
  if (line.subtype) {
    const subLines = wrapToWidth(line.subtype, cols.item.w, fontRegular, 9);
    for (const ln of subLines) {
      page.drawText(ln, { x: cols.item.x, y, size: 9, font: fontRegular, color: INK_HIGH });
      y -= 11;
    }
  }
  if (line.reference) {
    page.drawText(line.reference, { x: cols.item.x, y, size: 7.5, font: fontRegular, color: INK_SOFT });
    y -= 10;
  }
  if (line.notes) {
    page.drawText(truncate('Nota: ' + line.notes, 60), { x: cols.item.x, y, size: 7.5, font: fontItalic || fontRegular, color: INK_MID });
    y -= 10;
  }
  const articleBottomY = y;

  // Detail column — dimensions then description, top-aligned with the row.
  // Both wrap to the now-spacious column. specBottomY is tracked for the
  // row-height computation below.
  let sy = rowY - ROW_TOP_PAD;
  for (const seg of specSegments(line)) {
    const wrappedLines = wrapToWidth(seg.text, cols.spec.w, fontRegular, seg.size);
    for (const ln of wrappedLines) {
      // Each line draws with its top at sy (text baseline at sy - size).
      page.drawText(ln, { x: cols.spec.x, y: sy - seg.size, size: seg.size, font: fontRegular, color: seg.color });
      sy -= seg.lh;
    }
  }
  const detailBottomY = sy;

  // Numeric column — vertical center of the image (so the right-side
  // numbers anchor optically to the photograph). All three values share
  // one baseline so the eye reads them as a row, not as a tower.
  const numY = boxY + (cols.img.h / 2) - 4;
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);
  drawRightAt(page, String(line.qty || 0),                       cols.qty.rightX,  numY, 10,   fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(unit,  ctx.currency, ctx.rates), cols.unit.rightX, numY, 10,   fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(total, ctx.currency, ctx.rates), cols.tot.rightX,  numY, 11,   fontBold,    INK);

  // Row bottom = deepest of (article text, detail text) plus padding.
  // articleBottomY and detailBottomY are both growing downward (negative
  // direction in PDF coords) — Math.min picks the most-negative value.
  const contentBottomY = Math.min(articleBottomY, detailBottomY);
  const rowBottom = contentBottomY - ROW_BOTTOM_PAD;

  page.drawLine({
    start: { x: MARGIN_L, y: rowBottom },
    end:   { x: PAGE_W - MARGIN_R, y: rowBottom },
    thickness: 0.5,
    color: INK_LINE,
  });

  return { x: MARGIN_L, y: rowBottom };
}
