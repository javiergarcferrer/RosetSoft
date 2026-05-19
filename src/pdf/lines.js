import { applyLineAdjustments } from '../lib/pricing.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R, CONTENT_W,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, BG_SOFT, BRAND_700,
} from './constants.js';
import { drawRightAt, formatMoney } from './util.js';
import { embedImageById } from './embed.js';

// ---------------------------------------------------------------------------
// Line-items layout. Mirrors the on-screen ClientPreview.jsx so the PDF
// the customer receives looks identical to what the dealer showed them
// in the live preview.
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ ┌────┐  KOBOLD                       CANTIDAD                │
//   │ │img │  RIGHT-ARM SOFA WITH SHORT…   1                       │
//   │ │ 80 │  Grade G                      UNITARIO                │
//   │ │ 80 │  H 28 " x L 89 " x P 43 "     $11,310.00              │
//   │ └────┘  Choice of natural or…        TOTAL                   │
//   │         Opcion de añadir cojín…      $11,310.00              │
//   └──────────────────────────────────────────────────────────────┘
//   ←─ 80 ─→ ←─ flexible detail column ──→ ←──── 110 ────→
//
// Three logical columns:
//   1. Image      — square 80×80 product photo, vertically centered
//                   in the row.
//   2. Detail     — family eyebrow (brand-700), name (bold), subtype,
//                   dimensions, description, notes. Drives row height.
//   3. Numeric    — three label/value pairs stacked vertically, all
//                   right-aligned to the right page margin. Labels are
//                   brand-700 eyebrows; values are tabular numbers in
//                   ink. Total is one size bigger and bolder than qty
//                   / unit.
//
// What changed from the previous design:
//   * No dark column-header strip ("ARTÍCULO DETALLE CANT. UNIT. TOTAL").
//     The preview doesn't show one; the numbers are self-explanatory
//     because each carries its own label inline.
//   * Family is brand-700 (terracotta) instead of ink-mid — matches the
//     chip color in the rest of the app.
//   * Numbers stack vertically rather than sitting on the name's
//     baseline, so a long product name doesn't crowd the qty/unit
//     column.
// ---------------------------------------------------------------------------

// Image sizing — the dealer's directive: "I need bigger images. They
// should be much bigger. Give each product a quarter page of space."
// Letter page is 792pt tall; a quarter is 198pt. With the row's top +
// bottom padding (14 + 14 = 28pt), that leaves 170pt for the image.
// At 170pt square (~60mm) the product photo is visible from across the
// dealer's desk; the previous 80pt thumb was easy to miss.
//
// The contain-fit scale was bumped from 0.92 → 0.96 to fill more of
// the box now that the image dominates the row — at the larger size
// the thin matte that 0.92 reserved no longer reads as "intentional
// breathing room", it reads as wasted space.
const IMAGE_SIZE = 170;
const IMG_GUTTER = 18;
const NUMERIC_COL_W = 100;    // trimmed from 110 → 100 to give the
                              // detail column a few extra points now
                              // that the image eats more of the row.

const ROW_TOP_PAD = 14;
const ROW_BOTTOM_PAD = 14;
const IDENTITY_TO_SPEC_GAP = 6;   // gap between identity block and physical specs
const SPEC_TO_NUMERIC_PAD = 16;   // breathing room between detail column and numeric column

// Type table — kept here so a typographic redesign rebalances in one
// place. The colors deliberately mirror the ClientPreview tokens.
//
// `notes` is intentionally absent: line.notes is labelled "Notas
// internas (no se imprimen)" in the editor, so it must not appear in
// the client-facing PDF.
const T = {
  family:      { size: 7.5, lh: 11, color: BRAND_700, cs: 1.5, bold: true },
  name:        { size: 12,  lh: 15, color: INK,       bold: true },
  subtype:     { size: 10,  lh: 13, color: INK_HIGH },
  // Meta strip: "ref <code> · <dimensions>" — combined into one
  // segment to mirror the preview's compact meta row.
  meta:        { size: 9,   lh: 12, color: INK_MID },
  description: { size: 9,   lh: 12, color: INK_HIGH },
  // Numeric column type
  numLabel:    { size: 7.5, lh: 11, color: BRAND_700, cs: 1.4, bold: true },
  numValue:    { size: 11,  lh: 14, color: INK },
  totalLabel:  { size: 7.5, lh: 11, color: BRAND_700, cs: 1.4, bold: true },
  totalValue:  { size: 14,  lh: 18, color: INK,       bold: true },
};

const NUMERIC_GAP = 6;   // vertical gap between qty/unit/total cells

function lineColumns() {
  const right = PAGE_W - MARGIN_R;
  const imgX = MARGIN_L;
  const detailX = imgX + IMAGE_SIZE + IMG_GUTTER;
  const numericRight = right;
  // Detail column ends where the numeric column starts (with padding).
  const detailW = CONTENT_W - IMAGE_SIZE - IMG_GUTTER - NUMERIC_COL_W - SPEC_TO_NUMERIC_PAD;

  return {
    img:     { x: imgX, y: null, w: IMAGE_SIZE, h: IMAGE_SIZE },
    detail:  { x: detailX, w: detailW },
    numeric: { rightX: numericRight, w: NUMERIC_COL_W },
  };
}

// ---------------------------------------------------------------------------
// Text-wrap helper. A single word longer than maxWidth is pushed unbroken
// so we never lose visible characters — the caller's hard rule is "never
// hide data".
// ---------------------------------------------------------------------------
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

function fontFor(ctx, token) {
  if (token.bold) return ctx.fontBold;
  if (token.italic) return ctx.fontItalic || ctx.fontRegular;
  return ctx.fontRegular;
}

/**
 * Produce the ordered list of detail-column segments for a line, each
 * already wrapped to the column width. Shared by the measure + draw
 * passes so they can't drift.
 */
function detailSegments(ctx, line, detailW) {
  const segs = [];
  function push(text, token) {
    if (!text) return;
    const lines = wrapToWidth(text, detailW, fontFor(ctx, token), token.size);
    if (lines.length) segs.push({ token, lines });
  }
  push(line.family ? line.family.toUpperCase() : '', T.family);
  push(line.name || '(sin nombre)', T.name);
  push(line.subtype, T.subtype);
  // Meta strip — reference + dimensions on one line, ' · ' separator,
  // same composition the preview uses. Skipped when both are empty.
  const meta = [
    line.reference ? `ref ${line.reference}` : null,
    line.dimensions,
  ].filter(Boolean).join(' · ');
  push(meta, T.meta);
  if (line.description && (line.family || line.name || line.subtype || meta)) {
    segs.push({ gap: IDENTITY_TO_SPEC_GAP });
  }
  push(line.description, T.description);
  return segs;
}

/**
 * Total height of the detail column at this line's content.
 */
function measureDetailHeight(ctx, line, detailW) {
  let h = 0;
  for (const seg of detailSegments(ctx, line, detailW)) {
    if (seg.gap) { h += seg.gap; continue; }
    h += seg.lines.length * seg.token.lh;
  }
  return h;
}

/**
 * Height of the numeric column: three (label + value + gap) blocks.
 * Constant per line — the column never wraps because money strings
 * stay on one line and the column is wide enough to fit them.
 */
function numericHeight() {
  return (
    T.numLabel.lh + T.numValue.lh + NUMERIC_GAP
    + T.numLabel.lh + T.numValue.lh + NUMERIC_GAP
    + T.totalLabel.lh + T.totalValue.lh
  );
}

/**
 * Row height = max(image, detail, numeric) + top + bottom padding.
 */
export function measureLineRowHeight(ctx, line) {
  const cols = lineColumns();
  const detailH = measureDetailHeight(ctx, line, cols.detail.w);
  const inner = Math.max(IMAGE_SIZE, detailH, numericHeight());
  return ROW_TOP_PAD + inner + ROW_BOTTOM_PAD;
}

/**
 * Section header — a brand-color eyebrow line, no chrome. The preview
 * renders "MOBILIARIO DE SALA" this way; the PDF should match.
 */
export function drawSectionHeader(page, ctx, cursor, label) {
  const { fontBold } = ctx;
  const size = 9;
  const tracking = 1.6;
  const y = cursor.y - size;
  page.drawText((label || '').toUpperCase(), {
    x: MARGIN_L, y,
    size, font: fontBold, color: BRAND_700,
    characterSpacing: tracking,
  });
  return { x: MARGIN_L, y: y - 18 };
}

/**
 * Centered "Sin artículos" placeholder so the totals block doesn't
 * appear to float over empty white space when the quote has no lines.
 */
export function drawEmptyLineBody(page, ctx, cursor) {
  const { fontRegular, fontItalic } = ctx;
  const boxH = 56;
  const top = cursor.y;
  const bottom = top - boxH;
  const msg = 'Sin artículos en esta cotización';
  const size = 9.5;
  const w = fontRegular.widthOfTextAtSize(msg, size);
  page.drawText(msg, {
    x: MARGIN_L + (CONTENT_W - w) / 2,
    y: top - (boxH / 2) - 3,
    size, font: fontItalic || fontRegular, color: INK_SOFT,
  });
  return { x: MARGIN_L, y: bottom };
}

/**
 * Render one line item row.
 */
export async function drawLineRow(page, ctx, cursor, line) {
  const { doc, fontBold, fontRegular } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const rowH = measureLineRowHeight(ctx, line);
  const inner = rowH - ROW_TOP_PAD - ROW_BOTTOM_PAD;
  const innerTop = rowY - ROW_TOP_PAD;

  // ---- Image — vertically centered in the inner content band -------------
  const img = await embedImageById(doc, line.imageId);
  const imgY = innerTop - (inner - IMAGE_SIZE) / 2 - IMAGE_SIZE;
  page.drawRectangle({
    x: cols.img.x, y: imgY, width: IMAGE_SIZE, height: IMAGE_SIZE,
    color: BG_SOFT, borderColor: INK_LINE, borderWidth: 0.5,
  });
  if (img) {
    // 0.96 contain-scale leaves the slightest matte so the photo
    // doesn't touch the box border (reads as intentional, not clipped),
    // while still filling enough of the 170pt box that the product
    // dominates the row visually.
    const scale = Math.min(IMAGE_SIZE / img.width, IMAGE_SIZE / img.height) * 0.96;
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: cols.img.x + (IMAGE_SIZE - w) / 2,
      y: imgY + (IMAGE_SIZE - h) / 2,
      width: w, height: h,
    });
  }

  // ---- Detail column — text flows top-to-bottom in hierarchy order -------
  let sy = innerTop;
  for (const seg of detailSegments(ctx, line, cols.detail.w)) {
    if (seg.gap) { sy -= seg.gap; continue; }
    const f = fontFor(ctx, seg.token);
    for (const ln of seg.lines) {
      const baselineY = sy - seg.token.size;
      page.drawText(ln, {
        x: cols.detail.x,
        y: baselineY,
        size: seg.token.size,
        font: f,
        color: seg.token.color,
        characterSpacing: seg.token.cs || 0,
      });
      sy -= seg.token.lh;
    }
  }

  // ---- Numeric column — three label/value pairs, right-aligned ----------
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);

  let ny = innerTop;
  function drawLabelValue(label, value, lblToken, valToken) {
    const lblY = ny - lblToken.size;
    drawRightAt(
      page, label, cols.numeric.rightX, lblY,
      lblToken.size, fontBold, lblToken.color, lblToken.cs || 0,
    );
    ny -= lblToken.lh;
    const valY = ny - valToken.size;
    drawRightAt(
      page, value, cols.numeric.rightX, valY,
      valToken.size, valToken.bold ? fontBold : fontRegular, valToken.color,
    );
    ny -= valToken.lh + NUMERIC_GAP;
  }

  drawLabelValue('CANTIDAD', String(line.qty || 0), T.numLabel, T.numValue);
  drawLabelValue('UNITARIO', formatMoney(unit,  ctx.currency, ctx.rates), T.numLabel, T.numValue);
  // No trailing gap after the last block — collapse it back.
  drawLabelValue('TOTAL',    formatMoney(total, ctx.currency, ctx.rates), T.totalLabel, T.totalValue);

  // ---- Bottom divider --------------------------------------------------
  const rowBottom = rowY - rowH;
  page.drawLine({
    start: { x: MARGIN_L, y: rowBottom },
    end:   { x: PAGE_W - MARGIN_R, y: rowBottom },
    thickness: 0.5, color: INK_LINE,
  });

  return { x: MARGIN_L, y: rowBottom };
}
