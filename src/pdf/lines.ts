import type { PDFPage, PDFFont, RGB } from 'pdf-lib';
import type { QuoteLine, LineComponent } from '../types/domain.ts';
import {
  applyLineAdjustments, isCompoundLine, componentSubtotal, compoundSubtotal,
  lineTotal, lineListUnit, lineQty,
} from '../lib/pricing.js';
import { rgb } from 'pdf-lib';
import {
  PAGE_W, MARGIN_L, MARGIN_R, CONTENT_W,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, INK_LINE2, BG_SOFT, BRAND_700,
  BRAND_300, EMERALD_700,
} from './constants.js';
import { drawRightAt, formatMoney } from './util.js';
import type { DrawTextOptions } from './util.js';
import { embedImageById } from './embed.js';
import type { PdfCtx, Cursor } from './types.js';

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

/**
 * One entry in the `T` type-token table — a triplet of (size, line-height,
 * color) plus optional weight / italic / character-spacing modifiers.
 * The renderer reads these at draw time so a typographic redesign can
 * rebalance values in one place.
 */
interface TypeToken {
  size: number;
  lh: number;
  color: RGB;
  cs?: number;
  bold?: boolean;
  italic?: boolean;
}

// Type table — kept here so a typographic redesign rebalances in one
// place. The colors deliberately mirror the ClientPreview tokens.
//
// `notes` is intentionally absent: line.notes is labelled "Notas
// internas (no se imprimen)" in the editor, so it must not appear in
// the client-facing PDF.
const T: Record<string, TypeToken> = {
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
  // Discount caption — surfaces under UNITARIO when the line carries a
  // line-level discount, so the customer can see the list price they're
  // saving against. Rendered in brand-700 to make the concession
  // legible at a glance against the otherwise-monochrome numeric column.
  numStrike:   { size: 9,   lh: 11, color: INK_SOFT },
  numDiscount: { size: 8.5, lh: 11, color: BRAND_700, bold: true },
  // Compound article — components rendered as a vertical stack
  // beneath the shared family + name. Each component carries its own
  // name, grade/fabric, ref/dim, plus an inline qty × unit = subtotal
  // equation right-aligned with the component name.
  compName:        { size: 10.5, lh: 13.5, color: INK,      bold: true },
  compSubtype:     { size: 9,    lh: 12,   color: INK_HIGH },
  compMeta:        { size: 8.5,  lh: 11,   color: INK_MID },
  compDescription: { size: 8.5,  lh: 11,   color: INK_HIGH },
  compInline:      { size: 9.5,  lh: 12,   color: INK },
  compTotalLabel:  { size: 7.5,  lh: 11,   color: BRAND_700, cs: 1.4, bold: true },
  compTotalValue:  { size: 14,   lh: 18,   color: INK,       bold: true },
};

const NUMERIC_GAP = 6;   // vertical gap between qty/unit/total cells

/**
 * One wrapped segment of detail-column text: a token + its (already
 * wrapped) lines, OR a vertical gap insert. The `kind` discriminator
 * lets TypeScript narrow which fields are present — see `lineDetail`
 * for how they're emitted.
 */
type DetailSegment =
  | { kind: 'text'; token: TypeToken; lines: string[] }
  | { kind: 'gap'; gap: number };

interface LineColumns {
  img: { x: number; y: number | null; w: number; h: number };
  detail: { x: number; w: number };
  numeric: { rightX: number; w: number };
}

interface CompoundColumns {
  img: { x: number; w: number; h: number };
  detail: { x: number; rightX: number; w: number };
}

function lineColumns(): LineColumns {
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
function wrapToWidth(
  text: string | null | undefined,
  maxWidth: number,
  font: PDFFont,
  size: number,
): string[] {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: string[] = [];
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

function fontFor(ctx: PdfCtx, token: TypeToken): PDFFont {
  if (token.bold) return ctx.fontBold;
  if (token.italic) return ctx.fontItalic || ctx.fontRegular;
  return ctx.fontRegular;
}

// Swatch geometry. The fabric swatch sits to the LEFT of the spec text
// (subtype + ref/dims), mirroring the client preview — not below it.
// That keeps rows short enough to pack onto a page. One square size for
// every swatch (line + compound component) so the document reads
// consistently.
const SWATCH_SIZE = 40;   // square — same size for lines and compound components
const SWATCH_GAP  = 8;    // horizontal gap between the swatch and the spec text

/** Sum the vertical height of a stack of detail segments. */
function segsHeight(segs: DetailSegment[]): number {
  let h = 0;
  for (const s of segs) h += s.kind === 'gap' ? s.gap : s.lines.length * s.token.lh;
  return h;
}

interface LineDetail {
  head: DetailSegment[];   // family eyebrow + product name (full detail width)
  spec: DetailSegment[];   // subtype + ref/dims (narrowed to sit beside the swatch)
  desc: DetailSegment[];   // description (full detail width)
}

/**
 * Split a line's detail column into three stacked bands so the layout
 * matches the client preview: head (family + name) spans the full width
 * on top; spec (subtype + ref/dims) is wrapped narrower so it sits to the
 * RIGHT of the swatch; description spans the full width underneath.
 * Shared by the measure + draw passes so they can't drift.
 */
function lineDetail(ctx: PdfCtx, line: QuoteLine, detailW: number): LineDetail {
  const specW = line.swatchImageId ? Math.max(60, detailW - SWATCH_SIZE - SWATCH_GAP) : detailW;
  const seg = (text: string | null | undefined, token: TypeToken, w: number): DetailSegment[] => {
    if (!text) return [];
    const lines = wrapToWidth(text, w, fontFor(ctx, token), token.size);
    return lines.length ? [{ kind: 'text', token, lines }] : [];
  };
  const meta = [
    line.reference ? `ref ${line.reference}` : null,
    line.dimensions,
  ].filter(Boolean).join(' · ');
  return {
    head: [
      ...seg(line.family ? line.family.toUpperCase() : '', T.family, detailW),
      ...seg(line.name || '(sin nombre)', T.name, detailW),
    ],
    spec: [
      ...seg(line.subtype, T.subtype, specW),
      ...seg(meta, T.meta, specW),
    ],
    desc: seg(line.description, T.description, detailW),
  };
}

/** Total height of the detail column — head + (swatch ∥ spec) + description. */
function measureDetailHeight(ctx: PdfCtx, line: QuoteLine, detailW: number): number {
  const { head, spec, desc } = lineDetail(ctx, line, detailW);
  const specBlock = line.swatchImageId ? Math.max(SWATCH_SIZE, segsHeight(spec)) : segsHeight(spec);
  const descGap = desc.length ? IDENTITY_TO_SPEC_GAP : 0;
  return segsHeight(head) + specBlock + descGap + segsHeight(desc);
}

/**
 * Draw a fabric swatch as a small framed square. `topY` is the TOP
 * edge in PDF coordinates (y grows upward), so the box occupies
 * [topY − size, topY]. Contain-scales the photo inside a soft-bordered
 * tile so it reads as a material sample, not a second product shot.
 * No-op when the image can't be embedded (deleted / unreadable).
 */
async function drawSwatch(
  page: PDFPage,
  doc: PdfCtx['doc'],
  imageId: string,
  x: number,
  topY: number,
  size: number = SWATCH_SIZE,
): Promise<void> {
  const boxY = topY - size;
  page.drawRectangle({
    x, y: boxY, width: size, height: size,
    color: BG_SOFT, borderColor: INK_LINE2, borderWidth: 0.5,
  });
  const swatch = await embedImageById(doc, imageId);
  if (swatch) {
    const scale = Math.min(size / swatch.width, size / swatch.height);
    const w = swatch.width * scale;
    const h = swatch.height * scale;
    page.drawImage(swatch, {
      x: x + (size - w) / 2,
      y: boxY + (size - h) / 2,
      width: w, height: h,
    });
  }
}

/**
 * Draw a stack of detail segments at column x, flowing down from the top
 * edge startY. Returns the y after the last line. Shared by the head /
 * spec / description bands so they all render identically.
 */
function drawSegs(page: PDFPage, ctx: PdfCtx, segs: DetailSegment[], x: number, startY: number): number {
  let sy = startY;
  for (const s of segs) {
    if (s.kind === 'gap') { sy -= s.gap; continue; }
    const f = fontFor(ctx, s.token);
    for (const ln of s.lines) {
      page.drawText(ln, {
        x, y: sy - s.token.size, size: s.token.size, font: f,
        color: s.token.color, characterSpacing: s.token.cs || 0,
      } as DrawTextOptions);
      sy -= s.token.lh;
    }
  }
  return sy;
}

/**
 * Height of the numeric column: three (label + value + gap) blocks.
 * Constant per line — the column never wraps because money strings
 * stay on one line and the column is wide enough to fit them.
 *
 * When the line carries a line-level discount we tack on two extra
 * caption lines under UNITARIO (struck-through list price + "–Y%"
 * caption) so the customer can see what they're saving against.
 */
function numericHeight(line: QuoteLine): number {
  const discount = Number(line?.lineDiscountPct) || 0;
  const extra = discount > 0 ? T.numStrike.lh + T.numDiscount.lh : 0;
  return (
    T.numLabel.lh + T.numValue.lh + NUMERIC_GAP
    + T.numLabel.lh + T.numValue.lh + extra + NUMERIC_GAP
    + T.totalLabel.lh + T.totalValue.lh
  );
}

/**
 * Row height = max(image, detail, numeric) + top + bottom padding.
 * Compound rows use a different geometry — the numeric column collapses
 * into the detail column, and each component contributes its own
 * sub-block (name + meta + inline equation). See compoundRowHeight().
 */
export function measureLineRowHeight(ctx: PdfCtx, line: QuoteLine): number {
  if (isCompoundLine(line)) return compoundRowHeight(ctx, line);
  const cols = lineColumns();
  const detailH = measureDetailHeight(ctx, line, cols.detail.w);
  const inner = Math.max(IMAGE_SIZE, detailH, numericHeight(line));
  // Reserve the caption band when the line is optional / in an
  // alternative group — same height contract both measure and draw
  // passes use so the page-break logic in quotePdf.ts always knows
  // the exact row footprint.
  const captionBand = lineOptionStyle(line, null) ? CAPTION_H : 0;
  return ROW_TOP_PAD + captionBand + inner + ROW_BOTTOM_PAD;
}

/* ----------------------------- compound ------------------------------ */
//
// Compound layout (single product family with N priced sub-rows):
//
//   ┌────────────────────────────────────────────────────────────────┐
//   │ ┌────────┐  TOGO                                               │
//   │ │        │  Composición de salón                                │
//   │ │ image  │  ─────────────────────────────────────────────────  │
//   │ │ 170pt  │  Settee 2P            1 × $4,500 = $4,500           │
//   │ │  sq    │  Grade C · Alpaga                                    │
//   │ │        │  ref Y3Y322 · H 28 × L 89 × P 43                    │
//   │ │        │  ─────────────────────────────────────────────────  │
//   │ │        │  Loveseat              1 × $3,200 = $3,200           │
//   │ │        │  ...                                                 │
//   │ └────────┘                                                       │
//   │                                            TOTAL COMPUESTO       │
//   │                                                  $8,800.00      │
//   └────────────────────────────────────────────────────────────────┘
//
// The numeric column from a normal row disappears — the per-component
// totals live inline (right-aligned) under the component name, and the
// roll-up TOTAL COMPUESTO sits as a single label/value pair under the
// component list. This keeps the eye scanning down the family + the
// list without zig-zagging across to a right column.

const COMP_HEADER_GAP = 6;        // gap between parent identity and components
const COMP_TOP_GAP    = 4;        // gap above each component (after divider)
const COMP_BLOCK_GAP  = 4;        // gap between component meta and next divider
const COMP_TOTAL_GAP  = 10;       // gap between last component and total block
const COMPOUND_DETAIL_GUTTER = 12; // breathing room between detail and right edge

function compoundColumns(): CompoundColumns {
  const right = PAGE_W - MARGIN_R;
  const imgX = MARGIN_L;
  const detailX = imgX + IMAGE_SIZE + IMG_GUTTER;
  // Compound's detail column extends nearly to the right margin —
  // the per-component qty × unit = subtotal equation lives inside
  // this column (right-aligned), so we don't reserve a separate
  // numeric track like normal lines do.
  const detailW = CONTENT_W - IMAGE_SIZE - IMG_GUTTER - COMPOUND_DETAIL_GUTTER;
  return {
    img:    { x: imgX, w: IMAGE_SIZE, h: IMAGE_SIZE },
    detail: { x: detailX, rightX: right, w: detailW },
  };
}

interface CompoundSegment {
  token: TypeToken;
  lines: string[];
}

function compoundHeaderSegments(ctx: PdfCtx, line: QuoteLine, detailW: number): CompoundSegment[] {
  const segs: CompoundSegment[] = [];
  function push(text: string | null | undefined, token: TypeToken): void {
    if (!text) return;
    const lines = wrapToWidth(text, detailW, fontFor(ctx, token), token.size);
    if (lines.length) segs.push({ token, lines });
  }
  push(line.family ? line.family.toUpperCase() : '', T.family);
  push(line.name, T.name);
  return segs;
}

/**
 * Brief, uppercase, tracked-eyebrow prefix that signals when a line
 * is an optional add-on or a member of an alternatives group. Output:
 *
 *   ''                                      — regular billed line
 *   'OPCIONAL · '                           — optional add-on
 *   'ALTERNATIVA — SELECCIONADA · '         — selected alternative
 *   'ALTERNATIVA · '                        — non-selected sibling
 *
 * Returns a trailing space + middot so the existing family text
 * concatenates cleanly: 'OPCIONAL · KOBOLD'. When both flags are
 * false (the common case) the prefix is empty and the family
 * eyebrow looks unchanged.
 *
 * `groupInfo` is reserved for the dealer-facing surfaces; the PDF
 * skips the index/total (e.g. "2/3") because the customer doesn't
 * benefit from the internal numbering — just the fact that the
 * line IS an alternative.
 */
/**
 * Style descriptor for a line that's an optional add-on or an
 * alternative-group member. Drives three visual elements that mirror
 * ClientPreview's accent + caption + opacity treatment:
 *
 *   accent   3-pt vertical bar drawn in the page-margin gutter just
 *            left of MARGIN_L. Brand-300 solid for alternatives, ink-
 *            soft for optionals — same colours the HTML left-border
 *            uses.
 *   caption  short uppercase eyebrow rendered above the row's
 *            content ("ALTERNATIVA 1 DE 2 · SELECCIONADA",
 *            "OPCIONAL · NO INCLUIDO"). Lifted into its own band so
 *            the customer reads the status before scanning the row,
 *            instead of decoding a prefix glued to the family name.
 *   dim      when true, the row content gets a semi-transparent
 *            white wash drawn over it (the image fades, the text
 *            greys) — replicating the 70% opacity rule ClientPreview
 *            applies to non-selected alternatives and to optionals.
 *
 * Returns null for ordinary lines so the renderer short-circuits and
 * draws nothing extra.
 */
interface LineOptionStyle {
  accent: RGB;
  caption: string;
  captionColor: RGB;
  dim: boolean;
}

function lineOptionStyle(
  line: QuoteLine,
  groupInfo?: { index: number; total: number } | null,
): LineOptionStyle | null {
  if (line.isOptional) {
    return {
      accent: INK_SOFT,
      caption: 'OPCIONAL · NO INCLUIDO',
      captionColor: INK_MID,
      dim: true,
    };
  }
  if (line.alternativeGroup) {
    const selected = !!line.isSelectedAlternative;
    const base = groupInfo
      ? `ALTERNATIVA ${groupInfo.index} DE ${groupInfo.total}`
      : 'ALTERNATIVA';
    return {
      accent: BRAND_300,
      caption: selected ? `${base} · SELECCIONADA` : base,
      captionColor: selected ? EMERALD_700 : BRAND_700,
      dim: !selected,
    };
  }
  return null;
}

// Geometry of the accent + caption band. Kept here so measure and
// draw passes can't drift.
const ACCENT_BAR_W   = 3;
const ACCENT_BAR_GAP = 6;   // space between bar and content (sits in the page margin)
const CAPTION_H      = 13;  // additional row-top reserved when caption is active
const CAPTION_SIZE   = 7.5;
const CAPTION_CS     = 1.4;

/**
 * Draws the accent bar in the page-margin gutter + the eyebrow
 * caption above the row's content. Returns the additional vertical
 * space the caption consumed so the caller can shift its inner
 * geometry down. Called BEFORE the row's main content so the
 * caption stays untouched by any wash overlay drawn after the
 * content.
 */
function drawOptionAccent(
  page: PDFPage,
  ctx: PdfCtx,
  style: LineOptionStyle,
  rowY: number,
  rowH: number,
): number {
  // Vertical bar — sits in the page margin (left of MARGIN_L) so it
  // doesn't displace any content column. Same x for every row.
  page.drawRectangle({
    x: MARGIN_L - ACCENT_BAR_GAP - ACCENT_BAR_W,
    y: rowY - rowH,
    width: ACCENT_BAR_W,
    height: rowH,
    color: style.accent,
  });

  // Caption eyebrow at the row top — small uppercase tracked text in
  // the row's MARGIN_L column. Sits above the family + image + detail
  // stack inside the ROW_TOP_PAD band.
  const captionY = rowY - ROW_TOP_PAD;
  page.drawText(style.caption, {
    x: MARGIN_L,
    y: captionY - CAPTION_SIZE,
    size: CAPTION_SIZE,
    font: ctx.fontBold,
    color: style.captionColor,
    characterSpacing: CAPTION_CS,
  } as DrawTextOptions);

  return CAPTION_H;
}

/**
 * Draws a semi-transparent white wash over the row's content area so
 * everything below (image, text, numerics) fades to ~65% — same
 * legibility rule ClientPreview's 70% opacity applies to non-selected
 * alternatives and optional rows. Must run AFTER the row's main draw
 * and BEFORE the accent + caption (those stay vivid).
 */
function drawOptionDim(
  page: PDFPage,
  rowY: number,
  rowH: number,
): void {
  page.drawRectangle({
    x: MARGIN_L,
    y: rowY - rowH,
    width: CONTENT_W,
    height: rowH,
    color: rgb(1, 1, 1),
    opacity: 0.35,
  });
}

// One component block: name + (optional) subtype + (optional) meta +
// (optional) description. The qty × unit = subtotal equation lives on
// the same baseline as the name, right-aligned, so the column reads
// as a labelled price row with subordinated specs beneath.
interface CompDetail {
  head: CompoundSegment[];   // component name (equation reserved on its first line)
  spec: CompoundSegment[];   // subtype + ref/dims (narrowed to sit beside the swatch)
  desc: CompoundSegment[];   // description
}

/**
 * Split a component into the same three bands as a line: name on top
 * (wrapped narrow so it clears the inline qty × unit = subtotal equation),
 * subtype + ref/dims beside the swatch, description underneath. Mirrors
 * lineDetail() so components and standalone lines render identically.
 */
function componentDetail(
  ctx: PdfCtx,
  component: LineComponent,
  detailW: number,
  nameW: number,
): CompDetail {
  const specW = component.swatchImageId ? Math.max(60, detailW - SWATCH_SIZE - SWATCH_GAP) : detailW;
  const seg = (text: string | null | undefined, token: TypeToken, w: number): CompoundSegment[] => {
    if (!text) return [];
    const lines = wrapToWidth(text, w, fontFor(ctx, token), token.size);
    return lines.length ? [{ token, lines }] : [];
  };
  // Optional components prefix the name with an "OPCIONAL · " eyebrow.
  const namePrefix = component.isOptional ? 'OPCIONAL · ' : '';
  const meta = [
    component.reference ? `ref ${component.reference}` : null,
    component.dimensions,
  ].filter(Boolean).join(' · ');
  return {
    head: seg(namePrefix + (component.name || '(sin nombre)'), T.compName, nameW),
    spec: [
      ...seg(component.subtype, T.compSubtype, specW),
      ...seg(meta, T.compMeta, specW),
    ],
    desc: seg(component.description, T.compDescription, detailW),
  };
}

/** Sum the vertical height of a stack of compound segments. */
function compSegsHeight(segs: CompoundSegment[]): number {
  let h = 0;
  for (const s of segs) h += s.lines.length * s.token.lh;
  return h;
}

/** Draw compound segments at column x from the top edge startY; returns new y. */
function drawCompSegs(page: PDFPage, ctx: PdfCtx, segs: CompoundSegment[], x: number, startY: number): number {
  let sy = startY;
  for (const s of segs) {
    const f = fontFor(ctx, s.token);
    for (const ln of s.lines) {
      page.drawText(ln, {
        x, y: sy - s.token.size, size: s.token.size, font: f,
        color: s.token.color, characterSpacing: s.token.cs || 0,
      } as DrawTextOptions);
      sy -= s.token.lh;
    }
  }
  return sy;
}

function compoundRowHeight(ctx: PdfCtx, line: QuoteLine): number {
  const cols = compoundColumns();
  // Parent identity (family + name) block.
  let textH = 0;
  for (const seg of compoundHeaderSegments(ctx, line, cols.detail.w)) {
    textH += seg.lines.length * seg.token.lh;
  }
  textH += COMP_HEADER_GAP;

  // Each component block contributes its own height.
  const components = line.components || [];
  // The qty × unit = subtotal inline equation reserves a track on the
  // right of each component's first line. We compute the maximum width
  // needed so wrapping accounts for it.
  const eqWidth = maxEquationWidth(ctx, line);
  const nameW = Math.max(40, cols.detail.w - eqWidth - 12);

  for (let i = 0; i < components.length; i++) {
    if (i > 0) textH += COMP_TOP_GAP;       // divider gap before this block
    const cd = componentDetail(ctx, components[i], cols.detail.w, nameW);
    const specTextH = compSegsHeight(cd.spec);
    const specBlockH = components[i].swatchImageId ? Math.max(SWATCH_SIZE, specTextH) : specTextH;
    textH += compSegsHeight(cd.head) + specBlockH + compSegsHeight(cd.desc);
    textH += COMP_BLOCK_GAP;
  }

  // Compound total block.
  textH += COMP_TOTAL_GAP + T.compTotalLabel.lh + T.compTotalValue.lh;
  // If a line-level discount is set, the footer mirrors the article
  // numeric column's discount stack: struck-through subtotal +
  // "Descuento –Y%" caption above the grand total. Two extra lh.
  if (Number(line.lineDiscountPct) || 0) {
    textH += T.numStrike.lh + T.numDiscount.lh;
  }

  const inner = Math.max(IMAGE_SIZE, textH);
  // Same caption band reservation as the article row — kept in sync
  // so the page-break logic always sees the row's true footprint.
  const captionBand = lineOptionStyle(line, null) ? CAPTION_H : 0;
  return ROW_TOP_PAD + captionBand + inner + ROW_BOTTOM_PAD;
}

// Widest "qty × unit = subtotal" equation across all components on
// this line. Used for layout reservation so each row's wrap width
// accommodates the longest equation it will render.
function maxEquationWidth(ctx: PdfCtx, line: QuoteLine): number {
  const { fontRegular } = ctx;
  let max = 0;
  const fmt = (v: number): string => formatMoney(v, ctx.currency, ctx.rates);
  for (const c of line.components || []) {
    const qty = Number(c.qty) || 0;
    const unit = Number(c.unitPrice) || 0;
    const sub = componentSubtotal(c);
    const text = `${qty} × ${fmt(unit)} = ${fmt(sub)}`;
    const w = fontRegular.widthOfTextAtSize(text, T.compInline.size);
    if (w > max) max = w;
  }
  return max;
}

/**
 * Section header — a brand-color eyebrow line, no chrome. The preview
 * renders "MOBILIARIO DE SALA" this way; the PDF should match.
 */
export function drawSectionHeader(
  page: PDFPage,
  ctx: PdfCtx,
  cursor: Cursor,
  label: string,
): Cursor {
  const { fontBold } = ctx;
  const size = 9;
  const tracking = 1.6;
  const y = cursor.y - size;
  page.drawText((label || '').toUpperCase(), {
    x: MARGIN_L, y,
    size, font: fontBold, color: BRAND_700,
    characterSpacing: tracking,
  } as DrawTextOptions);
  return { x: MARGIN_L, y: y - 18 };
}

/**
 * Centered "Sin artículos" placeholder so the totals block doesn't
 * appear to float over empty white space when the quote has no lines.
 */
export function drawEmptyLineBody(page: PDFPage, ctx: PdfCtx, cursor: Cursor): Cursor {
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
 * Render one line item row. Compound lines route to a dedicated
 * renderer with a different geometry (no right-side numeric column,
 * per-component inline equations, single roll-up total).
 */
export async function drawLineRow(
  page: PDFPage,
  ctx: PdfCtx,
  cursor: Cursor,
  line: QuoteLine,
  groupInfo?: { index: number; total: number } | null,
): Promise<Cursor> {
  if (isCompoundLine(line)) {
    return drawCompoundLineRow(page, ctx, cursor, line, groupInfo);
  }
  const { doc, fontBold, fontRegular } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const rowH = measureLineRowHeight(ctx, line);
  // Caption band sits in ROW_TOP_PAD's region — `inner` and
  // `innerTop` shift down by CAPTION_H when the line is optional
  // / in an alternative group, so the image + detail + numeric
  // stack lands below the caption rather than overlapping it.
  const style = lineOptionStyle(line, groupInfo);
  const captionBand = style ? CAPTION_H : 0;
  const inner = rowH - ROW_TOP_PAD - ROW_BOTTOM_PAD - captionBand;
  const innerTop = rowY - ROW_TOP_PAD - captionBand;

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

  // ---- Detail column — head (full width), then swatch + spec side by
  //      side, then description (full width); mirrors the client preview.
  const detail = lineDetail(ctx, line, cols.detail.w);
  let sy = drawSegs(page, ctx, detail.head, cols.detail.x, innerTop);
  const specTop = sy;
  if (line.swatchImageId) {
    await drawSwatch(page, doc, line.swatchImageId, cols.detail.x, specTop, SWATCH_SIZE);
  }
  const specX = line.swatchImageId ? cols.detail.x + SWATCH_SIZE + SWATCH_GAP : cols.detail.x;
  const afterSpec = drawSegs(page, ctx, detail.spec, specX, specTop);
  const specTextH = specTop - afterSpec;
  const specBlockH = line.swatchImageId ? Math.max(SWATCH_SIZE, specTextH) : specTextH;
  sy = specTop - specBlockH;
  if (detail.desc.length) {
    sy -= IDENTITY_TO_SPEC_GAP;
    sy = drawSegs(page, ctx, detail.desc, cols.detail.x, sy);
  }

  // ---- Numeric column — three label/value pairs, right-aligned ----------
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);
  const discount = Number(line.lineDiscountPct) || 0;
  const listUnit = lineListUnit(line);

  let ny = innerTop;
  function drawLabelValue(
    label: string,
    value: string,
    lblToken: TypeToken,
    valToken: TypeToken,
  ): void {
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
  // Discount caption between UNITARIO and TOTAL — only when a line
  // discount is set. Shows the list price with a strike-through line
  // (pdf-lib has no `text-decoration: line-through`, so we draw a
  // 0.6pt rule through the price string) and a brand-700 "–Y%"
  // caption underneath. Bumps TOTAL down by `numericHeight`'s extra
  // budget, which we reserved upstream.
  if (discount > 0) {
    // Strike-through list price. ny currently sits at the top of the
    // next block (post NUMERIC_GAP from UNITARIO). Roll the gap back
    // so the caption hugs UNITARIO instead of floating midway.
    ny += NUMERIC_GAP;
    const listText = formatMoney(listUnit, ctx.currency, ctx.rates);
    const listW = fontRegular.widthOfTextAtSize(listText, T.numStrike.size);
    const listY = ny - T.numStrike.size;
    drawRightAt(
      page, listText, cols.numeric.rightX, listY,
      T.numStrike.size, fontRegular, T.numStrike.color,
    );
    // Horizontal rule through the strike-through text. Centered on
    // the x-height (~0.4 of the size), 0.6pt thick.
    const strikeY = listY + T.numStrike.size * 0.32;
    page.drawLine({
      start: { x: cols.numeric.rightX - listW, y: strikeY },
      end:   { x: cols.numeric.rightX,         y: strikeY },
      thickness: 0.6, color: T.numStrike.color,
    });
    ny -= T.numStrike.lh;

    const discText = `Descuento –${discount}%`;
    const discY = ny - T.numDiscount.size;
    drawRightAt(
      page, discText, cols.numeric.rightX, discY,
      T.numDiscount.size, fontBold, T.numDiscount.color,
    );
    ny -= T.numDiscount.lh + NUMERIC_GAP;
  }
  // No trailing gap after the last block — collapse it back.
  drawLabelValue('TOTAL',    formatMoney(total, ctx.currency, ctx.rates), T.totalLabel, T.totalValue);

  // ---- Option / alternative treatment ----------------------------------
  // Three steps, in order: (1) wash overlay fades the row when the
  // line is optional or a non-selected alternative — mirrors the 70%
  // opacity rule ClientPreview applies. (2) accent bar in the gutter
  // and (3) caption above the row content always stay vivid (drawn
  // AFTER the wash so it can't fade them). Skipped entirely when the
  // line has no option/alternative state.
  if (style) {
    if (style.dim) drawOptionDim(page, rowY, rowH);
    drawOptionAccent(page, ctx, style, rowY, rowH);
  }

  // ---- Bottom divider --------------------------------------------------
  const rowBottom = rowY - rowH;
  page.drawLine({
    start: { x: MARGIN_L, y: rowBottom },
    end:   { x: PAGE_W - MARGIN_R, y: rowBottom },
    thickness: 0.5, color: INK_LINE,
  });

  return { x: MARGIN_L, y: rowBottom };
}

/**
 * Compound line row — one image + family + name header, then a vertical
 * stack of per-component blocks (name, subtype, ref/dim, optional
 * description) each with a right-aligned `qty × unit = subtotal`
 * equation, then a single "TOTAL COMPUESTO" pair at the bottom-right.
 *
 * Sized via compoundRowHeight() so the page-break logic in quotePdf.js
 * still gets an accurate row height for the break decision.
 */
async function drawCompoundLineRow(
  page: PDFPage,
  ctx: PdfCtx,
  cursor: Cursor,
  line: QuoteLine,
  groupInfo?: { index: number; total: number } | null,
): Promise<Cursor> {
  const { doc, fontBold, fontRegular } = ctx;
  const cols = compoundColumns();
  const rowY = cursor.y;
  const rowH = measureLineRowHeight(ctx, line);
  const style = lineOptionStyle(line, groupInfo);
  const captionBand = style ? CAPTION_H : 0;
  const inner = rowH - ROW_TOP_PAD - ROW_BOTTOM_PAD - captionBand;
  const innerTop = rowY - ROW_TOP_PAD - captionBand;

  // ---- Image (same chrome as a normal row, top-aligned in the band) -----
  const img = await embedImageById(doc, line.imageId);
  // Top-align the image so the family + name header sits next to its
  // top edge — a centered image floating below the title looked
  // detached when the component list grew taller than the image.
  const imgY = innerTop - IMAGE_SIZE;
  page.drawRectangle({
    x: cols.img.x, y: imgY, width: IMAGE_SIZE, height: IMAGE_SIZE,
    color: BG_SOFT, borderColor: INK_LINE, borderWidth: 0.5,
  });
  if (img) {
    const scale = Math.min(IMAGE_SIZE / img.width, IMAGE_SIZE / img.height) * 0.96;
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: cols.img.x + (IMAGE_SIZE - w) / 2,
      y: imgY + (IMAGE_SIZE - h) / 2,
      width: w, height: h,
    });
  }

  // ---- Detail column — family + name, then component blocks -------------
  let sy = innerTop;
  for (const seg of compoundHeaderSegments(ctx, line, cols.detail.w)) {
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
      } as DrawTextOptions);
      sy -= seg.token.lh;
    }
  }
  sy -= COMP_HEADER_GAP;

  // Light divider between the header and the component list — mirrors
  // the on-screen preview's hairline border.
  page.drawLine({
    start: { x: cols.detail.x, y: sy + 2 },
    end:   { x: cols.detail.rightX, y: sy + 2 },
    thickness: 0.5, color: INK_LINE,
  });

  const components = line.components || [];
  const eqWidth = maxEquationWidth(ctx, line);
  const nameW = Math.max(40, cols.detail.w - eqWidth - 12);

  for (let i = 0; i < components.length; i++) {
    if (i > 0) {
      // Hairline between components.
      page.drawLine({
        start: { x: cols.detail.x, y: sy + 2 },
        end:   { x: cols.detail.rightX, y: sy + 2 },
        thickness: 0.5, color: INK_LINE,
      });
      sy -= COMP_TOP_GAP;
    }
    sy = await drawComponentBlock(page, ctx, sy, cols, components[i], nameW);
    sy -= COMP_BLOCK_GAP;
  }

  // ---- Compound roll-up total -------------------------------------------
  // Footer is a right-aligned vertical stack with the same shape as the
  // article line's numeric column: (struck list price, brand "Descuento
  // –Y%" caption) when discounted, then a TOTAL COMPUESTO label/value
  // pair. Sharing the vocabulary keeps the design system honest — a
  // customer reading the quote sees the same discount treatment on a
  // single article and on a compound bundle.
  sy -= COMP_TOTAL_GAP;
  const subtotal = compoundSubtotal(line);
  const discount = Number(line.lineDiscountPct) || 0;
  const grandTotal = lineTotal(line);
  const fmt = (v: number): string => formatMoney(v, ctx.currency, ctx.rates);

  if (discount !== 0) {
    // Struck-through subtotal — same treatment as the article line's
    // "antes" strike under UNITARIO. pdf-lib has no text-decoration,
    // so we draw a 0.6pt rule across the price string at the x-height.
    const listText = fmt(subtotal);
    const listW = fontRegular.widthOfTextAtSize(listText, T.numStrike.size);
    const listY = sy - T.numStrike.size;
    drawRightAt(
      page, listText, cols.detail.rightX, listY,
      T.numStrike.size, fontRegular, T.numStrike.color,
    );
    const strikeY = listY + T.numStrike.size * 0.32;
    page.drawLine({
      start: { x: cols.detail.rightX - listW, y: strikeY },
      end:   { x: cols.detail.rightX,         y: strikeY },
      thickness: 0.6, color: T.numStrike.color,
    });
    sy -= T.numStrike.lh;

    const discText = `Descuento –${discount}%`;
    const discY = sy - T.numDiscount.size;
    drawRightAt(
      page, discText, cols.detail.rightX, discY,
      T.numDiscount.size, fontBold, T.numDiscount.color,
    );
    sy -= T.numDiscount.lh;
  }
  const totalLblY = sy - T.compTotalLabel.size;
  drawRightAt(
    page, 'TOTAL COMPUESTO', cols.detail.rightX, totalLblY,
    T.compTotalLabel.size, fontBold, T.compTotalLabel.color, T.compTotalLabel.cs,
  );
  sy -= T.compTotalLabel.lh;
  const totalValY = sy - T.compTotalValue.size;
  drawRightAt(
    page, fmt(grandTotal), cols.detail.rightX, totalValY,
    T.compTotalValue.size, fontBold, T.compTotalValue.color,
  );

  // ---- Option / alternative treatment ----------------------------------
  // Same three-step finish as the article row — wash first, accent +
  // caption last so they stay vivid against the faded content.
  if (style) {
    if (style.dim) drawOptionDim(page, rowY, rowH);
    drawOptionAccent(page, ctx, style, rowY, rowH);
  }

  // ---- Bottom divider ---------------------------------------------------
  const rowBottom = rowY - rowH;
  page.drawLine({
    start: { x: MARGIN_L, y: rowBottom },
    end:   { x: PAGE_W - MARGIN_R, y: rowBottom },
    thickness: 0.5, color: INK_LINE2,
  });

  return { x: MARGIN_L, y: rowBottom };
}

// Draws one component block (name + subordinated specs on the left,
// inline qty × unit = subtotal equation on the right of the first
// baseline). Returns the y after the block has been drawn.
async function drawComponentBlock(
  page: PDFPage,
  ctx: PdfCtx,
  startY: number,
  cols: CompoundColumns,
  component: LineComponent,
  nameW: number,
): Promise<number> {
  const { fontRegular, doc } = ctx;
  const fmt = (v: number): string => formatMoney(v, ctx.currency, ctx.rates);
  const qty = Number(component.qty) || 0;
  const unit = Number(component.unitPrice) || 0;
  const sub = componentSubtotal(component);
  // Optional components show the equation with a leading "+ " on the
  // subtotal, signalling "if you add this, the compound total grows
  // by X". Mirrors the on-screen ClientPreview treatment so the
  // customer reads the same convention across surfaces.
  const eqText = component.isOptional
    ? `${qty} × ${fmt(unit)} = + ${fmt(sub)}`
    : `${qty} × ${fmt(unit)} = ${fmt(sub)}`;

  const cd = componentDetail(ctx, component, cols.detail.w, nameW);
  // Head: the component name, with the inline equation right-aligned on
  // its first line.
  let sy = startY;
  let first = true;
  for (const s of cd.head) {
    const f = fontFor(ctx, s.token);
    for (const ln of s.lines) {
      page.drawText(ln, {
        x: cols.detail.x, y: sy - s.token.size, size: s.token.size,
        font: f, color: s.token.color, characterSpacing: s.token.cs || 0,
      } as DrawTextOptions);
      if (first) {
        drawRightAt(
          page, eqText, cols.detail.rightX, sy - T.compInline.size,
          T.compInline.size, fontRegular, T.compInline.color,
        );
        first = false;
      }
      sy -= s.token.lh;
    }
  }
  // Swatch (left) + subtype/ref-dims (beside it), then description below —
  // identical band order to the standalone line.
  const specTop = sy;
  if (component.swatchImageId) {
    await drawSwatch(page, doc, component.swatchImageId, cols.detail.x, specTop, SWATCH_SIZE);
  }
  const specX = component.swatchImageId ? cols.detail.x + SWATCH_SIZE + SWATCH_GAP : cols.detail.x;
  const afterSpec = drawCompSegs(page, ctx, cd.spec, specX, specTop);
  const specTextH = specTop - afterSpec;
  const specBlockH = component.swatchImageId ? Math.max(SWATCH_SIZE, specTextH) : specTextH;
  sy = specTop - specBlockH;
  sy = drawCompSegs(page, ctx, cd.desc, cols.detail.x, sy);
  return sy;
}
