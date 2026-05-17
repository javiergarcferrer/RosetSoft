import { rgb } from 'pdf-lib';
import { applyLineAdjustments } from '../lib/pricing.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R, CONTENT_W,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, BG_SOFT,
} from './constants.js';
import { drawRightAt, formatMoney } from './util.js';
import { embedImageById } from './embed.js';

// ---------------------------------------------------------------------------
// Line-items table geometry.
//
// Three equal-width sections summing to CONTENT_W. The columns have a clean
// semantic separation: ARTÍCULO is purely visual (the product photo),
// DETALLE carries every piece of text describing the product in hierarchy
// order, and the right column carries the math.
//
//   ┌────────────────────┬─────────────────────────┬───────────────────┐
//   │ ARTÍCULO           │ DETALLE                 │ CANT. UNIT. TOTAL │
//   │                    │ AMÉDÉE                  │                   │
//   │ ┌────────────┐     │ Sofá 2-plazas Pampa     │   1  $4180 $4180  │
//   │ │  130 × 95  │     │ Grade C — PAMPA         │                   │
//   │ │   image    │     │ ref 18211150            │                   │
//   │ │            │     │                         │                   │
//   │ └────────────┘     │ H 33 W 30¼ D 32¼ S 15   │                   │
//   │                    │ Sofá de dos plazas en   │                   │
//   │                    │ tela. Color a elegir…   │                   │
//   └────────────────────┴─────────────────────────┴───────────────────┘
//   56 ←──── ~167pt ─────→ 223 ←──── ~167pt ─────→ 390 ←──── ~167pt ──→ 556
//
// Hierarchy inside DETALLE (top to bottom):
//   1. Family       — small caps, ink-mid (price-list collection name)
//   2. Name         — bold, ink-900, wraps to column width (HERO)
//   3. Subtype      — Grade X — Fabric, regular, ink-high
//   4. Reference    — small, ink-soft (catalog lookup key)
//   5. (4pt gap)
//   6. Dimensions   — ink-high, monospace-ish numeric reading
//   7. Description  — ink-soft, wraps over multiple lines if needed
//   8. Notes        — italic, ink-mid, prefixed "Nota:"
// ---------------------------------------------------------------------------

// Image footprint inside the article column. Slightly cinematic (wider than
// tall) — furniture is photographed in landscape; square crops too tight.
// 130 × 95 lands at 1.37 ratio (close to 4:3) which reads as a photo, not
// a thumbnail.
const IMAGE_W = 130;
const IMAGE_H = 95;

const ROW_TOP_PAD = 10;
const ROW_BOTTOM_PAD = 10;
const IDENTITY_TO_SPEC_GAP = 6;  // gap between Reference and Dimensions

// Detail-column type sizes + line heights. Centralised so a redesign can
// rebalance the hierarchy in one place.
const T = {
  family:      { size: 7,    lh: 10, color: INK_MID,  cs: 1.2 },
  name:        { size: 11,   lh: 13, color: INK,      bold: true },
  subtype:     { size: 9,    lh: 11, color: INK_HIGH },
  reference:   { size: 7.5,  lh: 10, color: INK_SOFT },
  dimensions:  { size: 8.5,  lh: 11, color: INK_HIGH },
  description: { size: 7.5,  lh: 10, color: INK_SOFT },
  notes:       { size: 7.5,  lh: 10, color: INK_MID,  italic: true },
};

// Three equal columns. CONTENT_W is 500pt on US Letter; thirds give 166-167.
function lineColumns() {
  const right = PAGE_W - MARGIN_R;
  const colW = Math.floor(CONTENT_W / 3);

  const article = { x: MARGIN_L,            w: colW };
  const detail  = { x: MARGIN_L + colW,     w: colW };
  const numeric = { x: MARGIN_L + 2 * colW, w: CONTENT_W - 2 * colW };

  // Image centered horizontally inside its column — symmetric whitespace on
  // both sides reads as intentional framing rather than a left-aligned
  // photo with a chunk of empty space to its right.
  const imgX = article.x + Math.floor((article.w - IMAGE_W) / 2);

  // Detail column: 8pt left padding. The text wraps to (column - 16pt) so
  // there's symmetric breathing room against the column edges.
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
 * Resolve a font for a typography token from the type table. Falls back to
 * regular if a bold/italic variant wasn't embedded (defensive — production
 * always has all three).
 */
function fontFor(ctx, token) {
  if (token.bold) return ctx.fontBold;
  if (token.italic) return ctx.fontItalic || ctx.fontRegular;
  return ctx.fontRegular;
}

/**
 * Produce the ordered list of detail-column segments for a line, each
 * already wrapped to the column width. The shape is identical between the
 * measure and draw passes so they can't drift.
 */
function detailSegments(ctx, line, specW) {
  const segs = [];
  function push(text, token) {
    if (!text) return;
    const lines = wrapToWidth(text, specW, fontFor(ctx, token), token.size);
    if (lines.length) segs.push({ token, lines });
  }
  // Identity hierarchy
  push(line.family ? line.family.toUpperCase() : '', T.family);
  push(line.name || '(sin nombre)', T.name);
  push(line.subtype, T.subtype);
  push(line.reference, T.reference);
  // Visual gap between identity block and physical specs.
  if ((line.dimensions || line.description) && (line.family || line.name || line.subtype || line.reference)) {
    segs.push({ gap: IDENTITY_TO_SPEC_GAP });
  }
  // Physical / sourcing block
  push(line.dimensions, T.dimensions);
  push(line.description, T.description);
  push(line.notes ? `Nota: ${line.notes}` : '', T.notes);
  return segs;
}

/**
 * How tall this row will render. The detail column drives row height —
 * the image is a fixed-size box. Numeric column never grows beyond a
 * single line.
 */
export function measureLineRowHeight(ctx, line) {
  const cols = lineColumns();
  let detailDepth = ROW_TOP_PAD;
  for (const seg of detailSegments(ctx, line, cols.spec.w)) {
    if (seg.gap) { detailDepth += seg.gap; continue; }
    detailDepth += seg.lines.length * seg.token.lh;
  }
  const imageDepth = ROW_TOP_PAD + IMAGE_H;
  const contentDepth = Math.max(detailDepth, imageDepth);
  return contentDepth + ROW_BOTTOM_PAD;
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
  // ARTÍCULO sits centered above the image so the header reads as the
  // label for the visual column. DETALLE aligns with the left edge of
  // its text (where the eye lands when scanning the column).
  const articleLabelW = fontBold.widthOfTextAtSize(cols.itemLabel, labelSize);
  const articleLabelX = cols.article.x + (cols.article.w - articleLabelW) / 2;
  page.drawText(cols.itemLabel, { x: articleLabelX, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
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
 * Render one line item row.
 *
 *   ARTÍCULO column → image only (vertically centered against the detail
 *                     column's text block so the photo doesn't drift to
 *                     the top of a row whose text runs long).
 *   DETALLE column  → all product text in hierarchy order.
 *   Numeric column  → qty / unit / total aligned to the name's baseline,
 *                     so the eye reads "<product>: <count> × <unit> =
 *                     <total>" across a horizontal band per row.
 */
export async function drawLineRow(page, ctx, cursor, line) {
  const { doc, fontRegular, fontBold, fontItalic } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const rowH = measureLineRowHeight(ctx, line);

  // Detail column — draw first so we know where the name baseline lands
  // for the numeric column to align against.
  const segs = detailSegments(ctx, line, cols.spec.w);
  let sy = rowY - ROW_TOP_PAD;
  let nameBaselineY = sy;  // fallback if the line has no family / name
  for (const seg of segs) {
    if (seg.gap) { sy -= seg.gap; continue; }
    const f = fontFor(ctx, seg.token);
    for (const ln of seg.lines) {
      // PDF draws text with `y` at the baseline of the line. The text
      // visually extends from y to y + (cap height ~size * 0.7) above.
      // We track sy as the TOP of each line for predictable layout; the
      // baseline is sy - size.
      const baselineY = sy - seg.token.size;
      page.drawText(ln, {
        x: cols.spec.x,
        y: baselineY,
        size: seg.token.size,
        font: f,
        color: seg.token.color,
        characterSpacing: seg.token.cs || 0,
      });
      if (seg.token === T.name) nameBaselineY = baselineY;
      sy -= seg.token.lh;
    }
  }

  // Image — vertically centered in the row, horizontally centered in its
  // column. Centering keeps the photo and the text block visually weighted
  // against each other regardless of how long the description runs.
  const img = await embedImageById(doc, line.imageId);
  const boxX = cols.img.x;
  const boxY = rowY - (rowH / 2) - (cols.img.h / 2);
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

  // Numeric column — qty / unit / total share the name's baseline so the
  // three numbers sit on a single horizontal grid line with the product
  // name. That's the line the eye scans for "what costs what".
  const numY = nameBaselineY;
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);
  drawRightAt(page, String(line.qty || 0),                       cols.qty.rightX,  numY, 10,   fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(unit,  ctx.currency, ctx.rates), cols.unit.rightX, numY, 10,   fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(total, ctx.currency, ctx.rates), cols.tot.rightX,  numY, 11,   fontBold,    INK);

  const rowBottom = rowY - rowH;
  page.drawLine({
    start: { x: MARGIN_L, y: rowBottom },
    end:   { x: PAGE_W - MARGIN_R, y: rowBottom },
    thickness: 0.5,
    color: INK_LINE,
  });

  return { x: MARGIN_L, y: rowBottom };
}
