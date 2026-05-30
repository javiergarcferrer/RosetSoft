import type { PDFPage, PDFFont, PDFImage, RGB } from 'pdf-lib';
import type { QuoteLine, LineComponent, MaterialOptions } from '../types/domain.ts';
import {
  applyLineAdjustments, isCompoundLine, componentSubtotal, compoundSubtotal,
  lineTotal, lineListUnit, lineQty,
  materialOptionDeltas, isRangeLine, lineTotalRange, lineHasRange,
} from '../lib/pricing.js';
import { splitSkuGrade } from '../lib/catalog.js';
import { swatchProxyUrl } from '../lib/swatchImage.js';
import { colorCodeFromSubtype } from '../lib/swatchMatch.js';
import { rgb } from 'pdf-lib';
import {
  PAGE_W, MARGIN_L, MARGIN_R, CONTENT_W,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, INK_LINE2, BG_SOFT, BRAND_700,
  BRAND_300, ACCENT, EMERALD_700,
  BG_GROUP_SET, BAND_GROUP_SET, BRAND_50, BAND_GROUP_ALT,
  FS_TITLE, FS_EYEBROW, FS_BODY, FS_META, FS_EYEBROW_SM,
} from './constants.js';
import { drawRightAt, formatMoney } from './util.js';
import type { DrawTextOptions } from './util.js';
import { embedImageById, embedSwatch } from './embed.js';
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
  // Family eyebrow — RECLAIMED from terracotta to a neutral ink grey.
  // Terracotta now reads only on section headers + the grand total, so
  // sections become the brand-coloured landmarks instead of every row
  // shouting in brand colour.
  family:      { size: FS_EYEBROW_SM, lh: 11, color: INK_MID, cs: 1.5, bold: true },
  name:        { size: FS_TITLE,      lh: 16, color: INK,     bold: true },
  subtype:     { size: 10,            lh: 13, color: INK_HIGH },
  // Meta strip: "ref <code> · <dimensions>" — combined into one
  // segment to mirror the preview's compact meta row.
  meta:        { size: FS_BODY,       lh: 12, color: INK_MID },
  description: { size: FS_BODY,       lh: 12, color: INK_HIGH },
  // Compact money cell ----------------------------------------------------
  // ONE muted "n × $unit" line (`moneyLine`) sits above the bold line
  // TOTAL (`totalValue`). The repeated CANTIDAD / UNITARIO / TOTAL
  // eyebrows are gone — the equation + a single bold anchor carry the
  // meaning with far less noise.
  moneyLine:   { size: FS_META,       lh: 12, color: INK_MID },
  totalValue:  { size: 12,            lh: 16, color: INK,     bold: true },
  // Discount captions inside the money cell — struck list price + "−Y%".
  // Rendered just under the "n × $unit" line so the customer sees what
  // they're saving against. Brand-700 keeps the concession legible.
  numStrike:   { size: FS_META,       lh: 11, color: INK_SOFT },
  numDiscount: { size: FS_EYEBROW_SM, lh: 11, color: BRAND_700, bold: true },
  // Compound article — components rendered as a vertical stack
  // beneath the shared family + name. Each component carries its own
  // name, grade/fabric, ref/dim, plus an inline qty × unit = subtotal
  // equation right-aligned with the component name.
  compName:        { size: 10.5, lh: 13.5, color: INK,      bold: true },
  compSubtype:     { size: 9,    lh: 12,   color: INK_HIGH },
  compMeta:        { size: FS_META, lh: 11, color: INK_MID },
  compDescription: { size: FS_META, lh: 11, color: INK_HIGH },
  compInline:      { size: FS_BODY, lh: 12, color: INK_MID },
  compTotalLabel:  { size: FS_EYEBROW_SM, lh: 12, color: INK_MID, cs: 1.4, bold: true },
  compTotalValue:  { size: 13,   lh: 17,   color: INK,      bold: true },
  // Material-options grid — a uniform-swatch two-column list of the
  // materials a line can be re-quoted in. `moLabel` is the material name
  // (e.g. "ACATE · ANIS (#855)"); `moNote` is the per-cell note below it
  // ("incluido" on the base, or the signed price delta on an alternative).
  // The note's colour is set per cell at draw time (muted / emerald), so
  // the token colour here is just the default.
  moLabel:         { size: 8.5,  lh: 10.5, color: INK_HIGH, bold: true },
  moNote:          { size: 8,    lh: 9.5,  color: INK_MID },
};

const NUMERIC_GAP = 6;   // vertical gap between the money-cell line and the total

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

// Swatch geometry. A top-level line draws a LARGER swatch BELOW its spec
// text (subtype + ref/dims) so the fabric reads clearly; compound
// components keep a compact swatch beside their denser spec to stay
// packable on the page.
const SWATCH_SIZE = 40;        // compound component swatch — compact, beside the spec
const SWATCH_GAP  = 8;         // horizontal gap (compound component swatch ∥ spec)
const LINE_SWATCH_SIZE = 64;   // top-level line swatch — larger, sits below the spec
const SWATCH_TOP_GAP = 5;      // vertical gap between a line's spec text and its swatch

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
 * Split a line's detail column into three stacked bands: head (family +
 * name) on top, spec (subtype + ref/dims) — both full width — and the
 * description underneath. The fabric swatch is drawn BELOW the spec band
 * (see the draw pass), so spec no longer reserves room beside it.
 * Shared by the measure + draw passes so they can't drift.
 */
function lineDetail(ctx: PdfCtx, line: QuoteLine, detailW: number): LineDetail {
  const specW = detailW;
  const seg = (text: string | null | undefined, token: TypeToken, w: number): DetailSegment[] => {
    if (!text) return [];
    const lines = wrapToWidth(text, w, fontFor(ctx, token), token.size);
    return lines.length ? [{ kind: 'text', token, lines }] : [];
  };
  const meta = [
    line.reference ? `REF. ${line.reference}` : null,
    line.dimensions ? `DIM. ${line.dimensions}` : null,
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

/** Total height of the detail column — head + spec + (swatch below) + description. */
function measureDetailHeight(ctx: PdfCtx, line: QuoteLine, detailW: number): number {
  const { head, spec, desc } = lineDetail(ctx, line, detailW);
  const moCells = materialOptionCells(ctx, line.materialOptions, line.reference, line.swatchImageId, detailW);
  // The hero swatch is suppressed when the options grid renders (it repeats
  // the chosen material), so it only adds height when there are no cells —
  // the SAME condition drawLineRow uses, so measure + draw can't drift.
  const swatchBlock = (line.swatchImageId && moCells.length === 0) ? SWATCH_TOP_GAP + LINE_SWATCH_SIZE : 0;
  const moBlock = materialOptionsHeight(moCells);
  const descGap = desc.length ? IDENTITY_TO_SPEC_GAP : 0;
  return segsHeight(head) + segsHeight(spec) + swatchBlock + moBlock + descGap + segsHeight(desc);
}

/**
 * Draw a fabric swatch as a small framed square. `topY` is the TOP
 * edge in PDF coordinates (y grows upward), so the box occupies
 * [topY − size, topY]. Contain-scales the photo inside a soft-bordered
 * tile so it reads as a material sample, not a second product shot.
 * No-op when the image can't be embedded (deleted / unreadable).
 */
function drawSwatchImage(
  page: PDFPage,
  img: PDFImage | null,
  x: number,
  topY: number,
  size: number,
): void {
  const boxY = topY - size;
  page.drawRectangle({
    x, y: boxY, width: size, height: size,
    color: BG_SOFT, borderColor: INK_LINE2, borderWidth: 0.5,
  });
  if (img) {
    const scale = Math.min(size / img.width, size / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: x + (size - w) / 2,
      y: boxY + (size - h) / 2,
      width: w, height: h,
    });
  }
}

async function drawSwatch(
  page: PDFPage,
  doc: PdfCtx['doc'],
  imageId: string,
  x: number,
  topY: number,
  size: number = SWATCH_SIZE,
): Promise<void> {
  drawSwatchImage(page, await embedImageById(doc, imageId), x, topY, size);
}

// ---------------------------------------------------------------------------
// Material-options grid. The materials a line (or component) can be re-quoted
// in, laid out as a two-column grid flowing down. Each cell stacks a LARGE,
// uniform swatch tile on top with the material name + a note left-aligned
// directly BELOW it. The selected (base) material reads first as the anchor
// ("incluido"); each alternative follows with its signed price delta. Mirrors
// ClientPreview's MaterialOptionsStrip — no "OPCIONES DE MATERIAL" heading;
// the swatch + label is self-explanatory.
// ---------------------------------------------------------------------------
const MO_SWATCH       = 48;   // uniform swatch tile — same big size for every cell
const MO_IMG_TEXT_GAP = 4;    // gap between a cell's swatch and the text below it
const MO_COL_GAP      = 16;   // gap between the two columns
const MO_ROW_GAP      = 10;   // vertical gap between grid rows
const MO_TOP_GAP      = 9;    // gap above the grid (below the line's main swatch)
const MO_LABEL_MAX_LINES = 2;

interface MaterialCell {
  labelLines: string[];
  note: string | null;
  noteColor: RGB;
  swatch: { imageId?: string | null; url?: string | null };
  h: number;            // cell height = swatch + gap + text (label + note)
}

/**
 * Whether a line/component carries material options (so the grid renders).
 * When it does, the grid's first ("incluido") cell already shows the chosen
 * material's swatch — so the separate hero/spec swatch is suppressed to
 * avoid showing the same swatch twice.
 */
function hasMaterialOptions(mo: MaterialOptions | null | undefined): boolean {
  return Array.isArray(mo?.options) && mo.options.length > 0;
}

/** Whether a compound component draws its beside-spec swatch — only when it
 *  has a swatch AND no options grid (which would otherwise repeat it). */
function componentSwatchShown(c: LineComponent): boolean {
  return !!c.swatchImageId && !hasMaterialOptions(c.materialOptions);
}

/**
 * Build the material-options cells for a line/component: the base material
 * first ("incluido"), then each alternative with its signed price delta.
 * Pure (no image fetch) so the measure + draw passes share it and can't
 * drift. Deltas come from materialOptionDeltas when `ctx.families` resolves
 * a family for the SKU root; otherwise the cell shows label-only — the same
 * graceful degradation the on-screen preview uses.
 */
function materialOptionCells(
  ctx: PdfCtx,
  mo: MaterialOptions | null | undefined,
  reference: string | null | undefined,
  baseSwatchImageId: string | null | undefined,
  detailW: number,
): MaterialCell[] {
  const rawOptions = mo?.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return [];
  const baseLabel = mo?.baseLabel || mo?.baseGrade || '';

  // Price deltas — graceful: no families / no resolved family ⇒ label-only.
  let priced: ReturnType<typeof materialOptionDeltas> | null = null;
  if (ctx.families) {
    const root = splitSkuGrade(reference || '').root;
    const family = root ? ctx.families.get(root) : null;
    if (family) {
      try { priced = materialOptionDeltas(mo, family); } catch { priced = null; }
    }
  }

  const cellW = (detailW - MO_COL_GAP) / 2;
  // Text sits BELOW the swatch and wraps to the full cell width.
  const textW = Math.max(24, cellW);
  const labelFont = fontFor(ctx, T.moLabel);

  const cells: MaterialCell[] = [];
  const push = (
    label: string,
    swatch: { imageId?: string | null; url?: string | null },
    note: string | null,
    noteColor: RGB,
  ): void => {
    const labelLines = wrapToWidth(label, textW, labelFont, T.moLabel.size).slice(0, MO_LABEL_MAX_LINES);
    if (!labelLines.length) return;
    const textH = labelLines.length * T.moLabel.lh + (note ? T.moNote.lh : 0);
    cells.push({ labelLines, note, noteColor, swatch, h: MO_SWATCH + MO_IMG_TEXT_GAP + textH });
  };

  if (baseLabel) {
    push(
      baseLabel,
      { imageId: baseSwatchImageId, url: swatchProxyUrl(colorCodeFromSubtype(baseLabel)) },
      'incluido',
      INK_SOFT,
    );
  }

  const rows = priced && priced.length ? priced : rawOptions;
  for (const o of rows) {
    const d = (o as { delta?: number }).delta;
    const delta = typeof d === 'number' ? d : null;
    const note = delta != null
      ? `${delta < 0 ? '−' : '+'}${formatMoney(Math.abs(delta), ctx.currency, ctx.rates)}`
      : null;
    const noteColor = delta != null && delta < 0 ? EMERALD_700 : INK_MID;
    const code = o.code || colorCodeFromSubtype(o.label);
    push(o.label || '', { imageId: o.swatchImageId, url: swatchProxyUrl(code) }, note, noteColor);
  }
  return cells;
}

/** Total height of the material-options grid (0 when there are no cells). */
function materialOptionsHeight(cells: MaterialCell[]): number {
  if (!cells.length) return 0;
  let h = MO_TOP_GAP;
  for (let i = 0; i < cells.length; i += 2) {
    h += Math.max(cells[i].h, cells[i + 1]?.h ?? 0);
    if (i + 2 < cells.length) h += MO_ROW_GAP;
  }
  return h;
}

/**
 * Draw the material-options grid starting MO_TOP_GAP below `topY`, flowing
 * two columns down. Returns the y after the last row. Swatches embed via
 * embedSwatch (uploaded id OR the catalog color's remote swatch); a tile
 * that can't load stays an empty framed square so every cell keeps the
 * same footprint.
 */
async function drawMaterialOptions(
  page: PDFPage,
  ctx: PdfCtx,
  cells: MaterialCell[],
  x: number,
  topY: number,
  detailW: number,
): Promise<number> {
  if (!cells.length) return topY;
  const cellW = (detailW - MO_COL_GAP) / 2;
  const labelFont = fontFor(ctx, T.moLabel);
  const noteFont = fontFor(ctx, T.moNote);
  let y = topY - MO_TOP_GAP;
  for (let i = 0; i < cells.length; i += 2) {
    const rowCells = cells.slice(i, i + 2);
    const rowH = Math.max(...rowCells.map((c) => c.h));
    for (let j = 0; j < rowCells.length; j++) {
      const c = rowCells[j];
      const cellX = x + j * (cellW + MO_COL_GAP);
      // Swatch on top — occupies [y − MO_SWATCH, y].
      drawSwatchImage(page, await embedSwatch(ctx.doc, c.swatch), cellX, y, MO_SWATCH);
      // Text below the swatch, left edge flush with the swatch's left edge.
      let ty = y - MO_SWATCH - MO_IMG_TEXT_GAP;
      for (const ln of c.labelLines) {
        page.drawText(ln, {
          x: cellX, y: ty - T.moLabel.size, size: T.moLabel.size, font: labelFont, color: T.moLabel.color,
        } as DrawTextOptions);
        ty -= T.moLabel.lh;
      }
      if (c.note) {
        page.drawText(c.note, {
          x: cellX, y: ty - T.moNote.size, size: T.moNote.size, font: noteFont, color: c.noteColor,
        } as DrawTextOptions);
      }
    }
    y -= rowH;
    if (i + 2 < cells.length) y -= MO_ROW_GAP;
  }
  return y;
}

/**
 * The product photo box: a soft-bordered IMAGE_SIZE square with the photo
 * contain-scaled inside. `bottomY` is the box's bottom edge. Shared by the
 * initial draw and the redraw-on-top that keeps the photo vivid over an
 * option/alternative dim wash.
 */
function drawProductImage(page: PDFPage, img: PDFImage | null, x: number, bottomY: number): void {
  page.drawRectangle({
    x, y: bottomY, width: IMAGE_SIZE, height: IMAGE_SIZE,
    color: BG_SOFT, borderColor: INK_LINE, borderWidth: 0.5,
  });
  if (img) {
    // 0.96 contain-scale leaves the slightest matte so the photo doesn't
    // touch the box border (reads as intentional, not clipped).
    const scale = Math.min(IMAGE_SIZE / img.width, IMAGE_SIZE / img.height) * 0.96;
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: x + (IMAGE_SIZE - w) / 2,
      y: bottomY + (IMAGE_SIZE - h) / 2,
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
 * Height of the compact money cell:
 *
 *     2 × $1,606.50          ← moneyLine (qty × unit)
 *     $1,890.00              ← struck list price   ┐ only when the
 *     −15%                   ← discount caption     ┘ line is discounted
 *                            ← NUMERIC_GAP
 *     $3,213.00              ← line TOTAL (bold anchor)
 *
 * No CANTIDAD / UNITARIO / TOTAL eyebrows any more — the equation plus a
 * single bold total carry the meaning. Constant per line; money strings
 * never wrap because the cell is wide enough to fit them.
 */
function numericHeight(line: QuoteLine): number {
  const discount = Number(line?.lineDiscountPct) || 0;
  const extra = discount > 0 ? T.numStrike.lh + T.numDiscount.lh : 0;
  return T.moneyLine.lh + extra + NUMERIC_GAP + T.totalValue.lh;
}

/**
 * Row height = max(image, detail, numeric) + top + bottom padding.
 * Compound rows use a different geometry — the numeric column collapses
 * into the detail column, and each component contributes its own
 * sub-block (name + meta + inline equation). See compoundRowHeight().
 */
export function measureLineRowHeight(ctx: PdfCtx, line: QuoteLine, inZone: boolean = false): number {
  if (isCompoundLine(line)) return compoundRowHeight(ctx, line, inZone);
  const cols = lineColumns();
  const detailH = measureDetailHeight(ctx, line, cols.detail.w);
  const inner = Math.max(IMAGE_SIZE, detailH, numericHeight(line));
  // Reserve the top caption band when the row paints anything in it — its OWN
  // option/group caption (standalone), OR (inside a zone) the per-member
  // "SELECCIONADA" flag on the chosen alternative. Same height contract both
  // measure and draw passes use so the page-break logic always knows the
  // exact footprint.
  const captionBand = reservesTopBand(line, inZone) ? CAPTION_H : 0;
  return ROW_TOP_PAD + captionBand + inner + ROW_BOTTOM_PAD;
}

/**
 * Whether a row paints its own top caption + gutter accent. True for
 * optionals (always standalone), and for grouped members ONLY when NOT
 * inside a zone (a defensive fallback — in practice grouped runs always get
 * a zone). Inside a zone the identity lives in the header band, so the member
 * suppresses its caption. Keeps measure + draw in lockstep.
 */
function drawsOwnCaption(line: QuoteLine, inZone: boolean): boolean {
  const style = lineOptionStyle(line, null);
  if (!style) return false;
  if (inZone) return false;   // zone header band carries the identity
  return true;
}

/**
 * Inside an Alternativa zone, the CHOSEN option keeps a small per-member
 * "SELECCIONADA" flag (emerald) — the one status that's per-member, not group
 * identity, mirroring ClientPreview's in-card selected flag. Non-selected
 * siblings rely on the dim wash instead. Only meaningful inside a zone.
 */
function zoneSelectedFlag(line: QuoteLine, inZone: boolean): boolean {
  return inZone && !!line.alternativeGroup && !!line.isSelectedAlternative;
}

/** Whether the row reserves the CAPTION_H top band (own caption OR selected flag). */
function reservesTopBand(line: QuoteLine, inZone: boolean): boolean {
  return drawsOwnCaption(line, inZone) || zoneSelectedFlag(line, inZone);
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
 *            "OPCIONAL · NO INCLUIDO EN EL TOTAL"). Lifted into its own band so
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
      caption: 'OPCIONAL · NO INCLUIDO EN EL TOTAL',
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
  // Conjunto (set) member — the take-all twin of an alternative group.
  // Mutually exclusive with the two branches above (DB CHECK enforces
  // it), so this only runs for a pure set member. UNLIKE alternatives /
  // optionals it is NEVER dimmed: every member is fully priced and
  // counts toward the total, so it must read at full weight. Reuses the
  // `groupInfo` channel for its "N DE M" position (the caller passes the
  // set's index/total here for set lines). Neutral ink accent + caption to
  // match the on-screen preview's neutral Conjunto card (no purple).
  if (line.setGroup) {
    const base = groupInfo
      ? `CONJUNTO ${groupInfo.index} DE ${groupInfo.total}`
      : 'CONJUNTO';
    return {
      accent: INK_LINE2,
      caption: base,
      captionColor: INK_MID,
      dim: false,
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
 * Inside an Alternativa zone the chosen option carries a compact emerald
 * "SELECCIONADA" eyebrow in the row's top band (the per-member status that
 * ClientPreview shows in-card). Drawn AFTER the row content, in the CAPTION_H
 * band reserved at the row top, in the MARGIN_L column.
 */
function drawSelectedFlag(page: PDFPage, ctx: PdfCtx, rowY: number): void {
  const captionY = rowY - ROW_TOP_PAD;
  page.drawText('SELECCIONADA', {
    x: MARGIN_L + GROUP_RAIL_W + 8,
    y: captionY - CAPTION_SIZE,
    size: CAPTION_SIZE,
    font: ctx.fontBold,
    color: EMERALD_700,
    characterSpacing: CAPTION_CS,
  } as DrawTextOptions);
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

/**
 * Optional-component treatment for a compound block: a dashed accent bar
 * in the detail gutter + a white wash that fades the block. Mirrors the
 * client preview's dashed-border + dimmed optional component, so an
 * opt-in add-on reads the same in both surfaces. `topY` / `bottomY` are
 * the block's top + bottom in PDF coordinates (y grows upward).
 */
function drawComponentOptional(
  page: PDFPage,
  cols: CompoundColumns,
  topY: number,
  bottomY: number,
): void {
  // Wash over the block's content (swatch + specs + equation), fading it.
  page.drawRectangle({
    x: cols.detail.x - 4,
    y: bottomY,
    width: cols.detail.rightX - (cols.detail.x - 4),
    height: (topY - bottomY) + 2,
    color: rgb(1, 1, 1),
    opacity: 0.5,
  });
  // Dashed bar in the gutter, drawn AFTER the wash so it stays vivid.
  page.drawLine({
    start: { x: cols.detail.x - 9, y: topY },
    end:   { x: cols.detail.x - 9, y: bottomY },
    thickness: 1.5,
    color: INK_SOFT,
    dashArray: [2.5, 2.5],
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
  const specW = componentSwatchShown(component) ? Math.max(60, detailW - SWATCH_SIZE - SWATCH_GAP) : detailW;
  const seg = (text: string | null | undefined, token: TypeToken, w: number): CompoundSegment[] => {
    if (!text) return [];
    const lines = wrapToWidth(text, w, fontFor(ctx, token), token.size);
    return lines.length ? [{ token, lines }] : [];
  };
  // Optional / alternative components prefix the name with an eyebrow so the
  // opt-in or pick-one status reads in the PDF the same as on screen.
  const namePrefix = component.isOptional
    ? 'OPCIONAL · '
    : component.alternativeGroup
      ? (component.isSelectedAlternative ? 'ALTERNATIVA ELEGIDA · ' : 'ALTERNATIVA · ')
      : '';
  const meta = [
    component.reference ? `REF. ${component.reference}` : null,
    component.dimensions ? `DIM. ${component.dimensions}` : null,
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

function compoundRowHeight(ctx: PdfCtx, line: QuoteLine, inZone: boolean = false): number {
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
    const specBlockH = componentSwatchShown(components[i]) ? Math.max(SWATCH_SIZE, specTextH) : specTextH;
    const moBlock = materialOptionsHeight(
      materialOptionCells(ctx, components[i].materialOptions, components[i].reference, components[i].swatchImageId, cols.detail.w),
    );
    textH += compSegsHeight(cd.head) + specBlockH + compSegsHeight(cd.desc) + moBlock;
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
  // Same caption-band reservation rule as the article row — kept in sync
  // so the page-break logic always sees the row's true footprint.
  const captionBand = reservesTopBand(line, inZone) ? CAPTION_H : 0;
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
  subtotal: number | null = null,
): Cursor {
  const { fontBold } = ctx;
  const size = FS_EYEBROW;   // 11pt — sections are the brand-coloured landmarks
  const tracking = 1.6;
  const y = cursor.y - size;
  page.drawText((label || '').toUpperCase(), {
    x: MARGIN_L, y,
    size, font: fontBold, color: BRAND_700,
    characterSpacing: tracking,
  } as DrawTextOptions);
  // Section roll-up — the sum of the priced products in this section, right-
  // aligned on the eyebrow's baseline. Ink (not brand) so it reads as a number
  // rather than competing with the section landmark; shown only when non-zero.
  if (subtotal != null && subtotal > 0) {
    drawRightAt(
      page, formatMoney(subtotal, ctx.currency, ctx.rates),
      PAGE_W - MARGIN_R, y, 10.5, fontBold, INK,
    );
  }
  // Short terracotta rule under the eyebrow so the section reads as a
  // deliberate brand landmark, not just larger text. Now that no per-row
  // label is terracotta, this rule + the eyebrow are the only brand marks
  // in the body — exactly the "reclaimed accent" the redesign wants.
  const ruleY = y - 7;
  page.drawLine({
    start: { x: MARGIN_L, y: ruleY },
    end:   { x: MARGIN_L + SECTION_RULE_W, y: ruleY },
    thickness: 1.5, color: BRAND_700,
  });
  return { x: MARGIN_L, y: ruleY - 16 };
}

// Width of the short terracotta rule beneath a section eyebrow.
const SECTION_RULE_W = 34;

/* --------------------------- grouped-run ZONE --------------------------- */
//
// A Conjunto / Alternativa run is rendered as a bounded, SHADED zone so two
// runs placed back-to-back read as distinct containers instead of blurring
// together. The zone is built from per-member elements (a tint fill + a solid
// left rail under every row) so it continues cleanly across page breaks, and
// bracketed by two filled bands:
//
//   ┌─ GAP ──────────────────────────────────────────────────────┐  ← white gutter
//   │ ▌ CONJUNTO · 2 PIEZAS                          (header band)│
//   │ ▌··· member row (tint fill + left rail) ···················│
//   │ ▌··· member row ··········································   │
//   │ ▌ TOTAL DEL CONJUNTO                  $5,920.00 (footer band)│
//   └─ GAP ──────────────────────────────────────────────────────┘  ← white gutter
//
// The header band states the group identity ONCE (replacing the repeated
// "CONJUNTO N DE M" caption that used to sit on every member); the footer band
// is the "group ends" beat. Presentational only — members are already priced
// into the grand total (a set sums all members; an alternative bills only the
// selected option), so neither band adds a charge. Mirrors ClientPreview's
// GroupCard: Conjunto → neutral ink band/tint, Alternativa → brand-tinted.

// Separation rhythm — a clear white gutter before the header band and after the
// footer band so two adjacent groups have an unmistakable gap between them.
const GROUP_GAP_BEFORE = 15;
const GROUP_GAP_AFTER  = 15;

// The solid left accent RAIL that runs continuously down every member of a
// zone (and the bands), at the content's left edge. Wider than the old 3pt
// gutter mark so the shaded zone reads as one bracketed block. It sits just
// inside MARGIN_L, overlapping the member tint's left edge.
const GROUP_RAIL_W = 4;

// Opening header band geometry.
const GROUP_HEADER_PAD_T   = 7;
const GROUP_HEADER_PAD_B   = 7;
const GROUP_HEADER_LABEL_SZ = 9;
const GROUP_HEADER_LABEL_CS = 1.5;
const GROUP_HEADER_H = GROUP_HEADER_PAD_T + GROUP_HEADER_LABEL_SZ + GROUP_HEADER_PAD_B;

// Closing footer band geometry.
const GROUP_FOOTER_TOP_PAD    = 7;
const GROUP_FOOTER_BOTTOM_PAD = 7;
const GROUP_FOOTER_LABEL_SIZE = 8.5;
const GROUP_FOOTER_LABEL_CS   = 1.4;
const GROUP_FOOTER_VALUE_SIZE = 11;
const GROUP_FOOTER_H = GROUP_FOOTER_TOP_PAD
  + Math.max(GROUP_FOOTER_LABEL_SIZE, GROUP_FOOTER_VALUE_SIZE)
  + GROUP_FOOTER_BOTTOM_PAD;

/**
 * Visual palette for a grouped run's zone — the tints + accent + label colours
 * that make a Conjunto read neutral and an Alternativa read brand, matching
 * ClientPreview's GroupCard (head bg / member bg / foot bg / ring / eyebrow).
 *   memberFill  light tint behind every member row
 *   bandFill    deeper tint for the header + footer bands
 *   rail        solid left accent rail down the whole zone
 *   label       eyebrow / band-label colour
 */
export interface GroupZone {
  type: 'set' | 'alternative';
  memberFill: RGB;
  bandFill: RGB;
  rail: RGB;
  label: RGB;
}

// The two zone palettes. Conjunto → neutral ink (no purple), matching the
// preview's neutral set card; Alternativa → brand. The rail is the strongest
// tone so the bracket reads; fills are whisper-light so text stays legible.
const GROUP_ZONES: { set: GroupZone; alternative: GroupZone } = {
  set: {
    type: 'set',
    memberFill: BG_GROUP_SET,
    bandFill: BAND_GROUP_SET,
    rail: INK_HIGH,        // ink-800 — neutral-dark, continuous down the zone
    label: INK_MID,
  },
  alternative: {
    type: 'alternative',
    memberFill: BRAND_50,
    bandFill: BAND_GROUP_ALT,
    rail: ACCENT,          // brand-500
    label: BRAND_700,
  },
};

/** Resolve the zone palette for a run type. */
export function groupZoneFor(type: 'set' | 'alternative'): GroupZone {
  return type === 'set' ? GROUP_ZONES.set : GROUP_ZONES.alternative;
}

/**
 * Paint a member's zone backdrop — the light tint fill across the content
 * width plus the solid left accent rail — UNDER the row content (called from
 * drawLineRow before any text/image is drawn, so it can't cover them). Drawn
 * per member so the zone continues automatically onto a continuation page.
 * `rowY` is the row's top edge, `rowH` its full measured height.
 */
export function drawGroupMemberZone(
  page: PDFPage,
  zone: GroupZone,
  rowY: number,
  rowH: number,
): void {
  const top = rowY;
  const bottom = rowY - rowH;
  // Tint fill across the full content width.
  page.drawRectangle({
    x: MARGIN_L,
    y: bottom,
    width: CONTENT_W,
    height: top - bottom,
    color: zone.memberFill,
  });
  // Solid left rail at the content's left edge, continuous down every member.
  page.drawRectangle({
    x: MARGIN_L,
    y: bottom,
    width: GROUP_RAIL_W,
    height: top - bottom,
    color: zone.rail,
  });
}

/**
 * Vertical footprint of the opening header band (Conjunto / Alternativa),
 * INCLUDING the white gutter that precedes it. The caller folds this into the
 * first member's page-break budget so the band + first row never split.
 */
export function measureGroupHeaderHeight(): number {
  return GROUP_GAP_BEFORE + GROUP_HEADER_H;
}

/**
 * Vertical footprint of the closing footer band, INCLUDING the white gutter
 * that follows it. The caller adds this to the LAST member's page-break budget
 * so the footer never gets orphaned onto a fresh page away from its block.
 */
export function measureGroupFooterHeight(): number {
  return GROUP_FOOTER_H + GROUP_GAP_AFTER;
}

/**
 * Draw the opening header band of a grouped run, ONCE before its first member.
 * A filled bar spanning the content width with a solid left cap and a bold
 * eyebrow stating the group identity ("CONJUNTO · 2 PIEZAS" /
 * "ALTERNATIVAS · ELIGE UNA"). Consumes a white gutter above the band first
 * (GROUP_GAP_BEFORE) so it separates cleanly from whatever precedes it.
 * Returns the cursor just below the band (the first member draws from there).
 */
export function drawGroupHeaderBand(
  page: PDFPage,
  ctx: PdfCtx,
  cursor: Cursor,
  zone: GroupZone,
  memberCount: number,
  optional: boolean = false,
): Cursor {
  const { fontBold } = ctx;
  const top = cursor.y - GROUP_GAP_BEFORE;          // white gutter above
  const bottom = top - GROUP_HEADER_H;

  // Band fill across the content width.
  page.drawRectangle({
    x: MARGIN_L, y: bottom, width: CONTENT_W, height: GROUP_HEADER_H,
    color: zone.bandFill,
  });
  // Solid left cap — same rail as the members, continuous into the band.
  page.drawRectangle({
    x: MARGIN_L, y: bottom, width: GROUP_RAIL_W, height: GROUP_HEADER_H,
    color: zone.rail,
  });

  // Eyebrow: bold tracked label + a quieter descriptor. Only a Conjunto can
  // be optional; an Alternativa always uses one option.
  const label = zone.type === 'set'
    ? `CONJUNTO${optional ? ' OPCIONAL' : ''} · ${memberCount} ${memberCount === 1 ? 'PIEZA' : 'PIEZAS'}`
    : 'ALTERNATIVAS · ELIGE UNA';
  page.drawText(label, {
    x: MARGIN_L + GROUP_RAIL_W + 8,
    y: bottom + GROUP_HEADER_PAD_B,
    size: GROUP_HEADER_LABEL_SZ,
    font: fontBold,
    color: zone.label,
    characterSpacing: GROUP_HEADER_LABEL_CS,
  } as DrawTextOptions);

  return { x: MARGIN_L, y: bottom };
}

/**
 * Draw the closing footer band of a grouped run, ONCE after its last member.
 * A filled bar (deeper tint than the members) with the Spanish roll-up label
 * on the left and the amount right-aligned, bold, on the shared money column —
 * the clear "group ends" beat. Trails a white gutter (GROUP_GAP_AFTER) so the
 * next block separates cleanly. Returns the cursor below the gutter.
 */
export function drawGroupFooterBand(
  page: PDFPage,
  ctx: PdfCtx,
  cursor: Cursor,
  zone: GroupZone,
  label: string,
  amount: number,
  amountRange?: { min: number; max: number } | null,
): Cursor {
  const { fontBold } = ctx;
  const rightX = PAGE_W - MARGIN_R;
  const top = cursor.y;
  const bottom = top - GROUP_FOOTER_H;

  // Band fill across the content width — deeper than the member tint.
  page.drawRectangle({
    x: MARGIN_L, y: bottom, width: CONTENT_W, height: GROUP_FOOTER_H,
    color: zone.bandFill,
  });
  // Solid left cap — closes the rail at the bottom of the zone.
  page.drawRectangle({
    x: MARGIN_L, y: bottom, width: GROUP_RAIL_W, height: GROUP_FOOTER_H,
    color: zone.rail,
  });

  const baselineY = bottom + GROUP_FOOTER_BOTTOM_PAD
    + (Math.max(GROUP_FOOTER_LABEL_SIZE, GROUP_FOOTER_VALUE_SIZE) - GROUP_FOOTER_VALUE_SIZE) / 2;
  // Left eyebrow — uppercase tracked caption in the zone's label tone.
  page.drawText(label, {
    x: MARGIN_L + GROUP_RAIL_W + 8,
    y: baselineY + (GROUP_FOOTER_VALUE_SIZE - GROUP_FOOTER_LABEL_SIZE) * 0.5,
    size: GROUP_FOOTER_LABEL_SIZE,
    font: fontBold,
    color: zone.label,
    characterSpacing: GROUP_FOOTER_LABEL_CS,
  } as DrawTextOptions);

  // Right-aligned amount in ink, bold — same money formatter as the rows.
  // A material-less selected alternative rolls up as a "min – max" range.
  const amountText = amountRange
    ? `${formatMoney(amountRange.min, ctx.currency, ctx.rates)} – ${formatMoney(amountRange.max, ctx.currency, ctx.rates)}`
    : formatMoney(amount, ctx.currency, ctx.rates);
  drawRightAt(
    page, amountText, rightX - 6, baselineY,
    GROUP_FOOTER_VALUE_SIZE, fontBold, INK,
  );

  // Trail a white gutter so the next block clearly separates.
  return { x: MARGIN_L, y: bottom - GROUP_GAP_AFTER };
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
  zone?: GroupZone | null,
): Promise<Cursor> {
  if (isCompoundLine(line)) {
    return drawCompoundLineRow(page, ctx, cursor, line, groupInfo, zone);
  }
  const { doc, fontBold, fontRegular } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const inZone = !!zone;
  const rowH = measureLineRowHeight(ctx, line, inZone);

  // ---- Group-zone backdrop — tint fill + continuous left rail, drawn
  //      UNDER everything so a grouped run reads as one shaded container
  //      that carries across page breaks. Member's own caption is
  //      suppressed in a zone (identity lives in the header band).
  if (zone) drawGroupMemberZone(page, zone, rowY, rowH);

  // Caption band sits in ROW_TOP_PAD's region — `inner` and `innerTop` shift
  // down by CAPTION_H when the row paints anything in it: its OWN caption
  // (optional, or a grouped member rendered standalone) OR (inside a zone) the
  // selected-alternative flag. Otherwise the stack lands at the normal top.
  const style = lineOptionStyle(line, groupInfo);
  const ownCaption = drawsOwnCaption(line, inZone);
  const selectedFlag = zoneSelectedFlag(line, inZone);
  const captionBand = (ownCaption || selectedFlag) ? CAPTION_H : 0;
  const inner = rowH - ROW_TOP_PAD - ROW_BOTTOM_PAD - captionBand;
  const innerTop = rowY - ROW_TOP_PAD - captionBand;

  // ---- Image — vertically centered in the inner content band -------------
  const img = await embedImageById(doc, line.imageId);
  const imgY = innerTop - (inner - IMAGE_SIZE) / 2 - IMAGE_SIZE;
  drawProductImage(page, img, cols.img.x, imgY);

  // ---- Detail column — head (full width), then spec (full width), then a
  //      larger fabric swatch BELOW the spec, then description (full width).
  const detail = lineDetail(ctx, line, cols.detail.w);
  let sy = drawSegs(page, ctx, detail.head, cols.detail.x, innerTop);
  const specTop = sy;
  sy = drawSegs(page, ctx, detail.spec, cols.detail.x, specTop);
  // Material-options grid replaces the hero swatch when present (its first
  // "incluido" cell already shows the chosen material), so the standalone
  // swatch only draws when there are no options.
  const moCells = materialOptionCells(ctx, line.materialOptions, line.reference, line.swatchImageId, cols.detail.w);
  let swatchTopY: number | null = null;
  if (line.swatchImageId && !moCells.length) {
    sy -= SWATCH_TOP_GAP;
    swatchTopY = sy;
    await drawSwatch(page, doc, line.swatchImageId, cols.detail.x, swatchTopY, LINE_SWATCH_SIZE);
    sy -= LINE_SWATCH_SIZE;
  }
  if (moCells.length) {
    sy = await drawMaterialOptions(page, ctx, moCells, cols.detail.x, sy, cols.detail.w);
  }
  if (detail.desc.length) {
    sy -= IDENTITY_TO_SPEC_GAP;
    sy = drawSegs(page, ctx, detail.desc, cols.detail.x, sy);
  }

  // ---- Compact money cell — right-aligned to the shared money column ----
  // One muted "qty × $unit" line, an optional struck-list/−Y% discount
  // pair, then the line TOTAL as the bold anchor. No CANTIDAD / UNITARIO /
  // TOTAL eyebrows — they repeated on every row and competed with the
  // section landmarks for attention. The TOTAL aligns on the same right
  // money column as compound subtotals and group-footer values.
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);
  const discount = Number(line.lineDiscountPct) || 0;
  const listUnit = lineListUnit(line);
  const moneyRight = cols.numeric.rightX;
  // Material-less line — no single unit price; show "qty × rango" and the
  // price RANGE as the anchor instead of a concrete total.
  const ranged = isRangeLine(line);
  const totalR = ranged ? lineTotalRange(line) : null;

  let ny = innerTop;
  // "qty × $unit" — the per-unit story in one compact muted line.
  const eq = ranged
    ? `${line.qty || 0} × rango`
    : `${line.qty || 0} × ${formatMoney(unit, ctx.currency, ctx.rates)}`;
  drawRightAt(page, eq, moneyRight, ny - T.moneyLine.size, T.moneyLine.size, fontRegular, T.moneyLine.color);
  ny -= T.moneyLine.lh;

  // Discount: struck list price + "−Y%" caption, hugging the equation.
  // pdf-lib has no text-decoration, so we draw a 0.6pt rule across the
  // list-price string at the x-height.
  if (!ranged && discount > 0) {
    const listText = formatMoney(listUnit, ctx.currency, ctx.rates);
    const listW = fontRegular.widthOfTextAtSize(listText, T.numStrike.size);
    const listY = ny - T.numStrike.size;
    drawRightAt(page, listText, moneyRight, listY, T.numStrike.size, fontRegular, T.numStrike.color);
    const strikeY = listY + T.numStrike.size * 0.32;
    page.drawLine({
      start: { x: moneyRight - listW, y: strikeY },
      end:   { x: moneyRight,         y: strikeY },
      thickness: 0.6, color: T.numStrike.color,
    });
    ny -= T.numStrike.lh;

    const discText = `−${discount}%`;
    drawRightAt(page, discText, moneyRight, ny - T.numDiscount.size, T.numDiscount.size, fontBold, T.numDiscount.color);
    ny -= T.numDiscount.lh;
  }

  // Line TOTAL — the bold ink-900 anchor, ~12pt so it never rivals the
  // 24pt grand total but clearly owns the row's price.
  ny -= NUMERIC_GAP;
  const totalText = totalR
    ? `${formatMoney(totalR.min, ctx.currency, ctx.rates)} – ${formatMoney(totalR.max, ctx.currency, ctx.rates)}`
    : formatMoney(total, ctx.currency, ctx.rates);
  const totalTextSize = totalR ? T.totalValue.size * 0.8 : T.totalValue.size;
  drawRightAt(
    page, totalText, moneyRight,
    ny - totalTextSize, totalTextSize, fontBold, T.totalValue.color,
  );

  // ---- Option / alternative treatment ----------------------------------
  // Steps, in order: (1) wash overlay fades the row when the line is optional
  // or a non-selected alternative — mirrors the 70% opacity rule ClientPreview
  // applies; it still runs INSIDE a zone (a non-selected alternative member
  // must read dimmer than the chosen one). (2) the per-row gutter accent +
  // caption draw only when the row owns its caption (optional, or a grouped
  // member rendered standalone) — inside a zone the rail + header band carry
  // that, so this is skipped. Both stay vivid (drawn AFTER the wash).
  if (style) {
    if (style.dim) drawOptionDim(page, rowY, rowH);
    if (ownCaption) drawOptionAccent(page, ctx, style, rowY, rowH);
    // Redraw only the swatch on top of the wash so its fabric colour stays
    // vivid in any state; the product photo dims with the rest of a
    // deactivated (optional / non-selected alternative) row.
    if (style.dim && line.swatchImageId && swatchTopY != null) {
      await drawSwatch(page, doc, line.swatchImageId, cols.detail.x, swatchTopY, LINE_SWATCH_SIZE);
    }
  }
  // Inside a zone, the chosen alternative keeps its emerald "SELECCIONADA"
  // flag (never dimmed, so it stays vivid without a redraw).
  if (selectedFlag) drawSelectedFlag(page, ctx, rowY);

  // ---- Bottom divider --------------------------------------------------
  // Inside a zone the members are separated by the tint + rail rather than a
  // hairline; a divider would cut the shaded container in two. Standalone rows
  // keep their light divider so the white-page rhythm holds.
  const rowBottom = rowY - rowH;
  if (!zone) {
    page.drawLine({
      start: { x: MARGIN_L, y: rowBottom },
      end:   { x: PAGE_W - MARGIN_R, y: rowBottom },
      thickness: 0.5, color: INK_LINE,
    });
  }

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
  zone?: GroupZone | null,
): Promise<Cursor> {
  const { doc, fontBold, fontRegular } = ctx;
  const cols = compoundColumns();
  const rowY = cursor.y;
  const inZone = !!zone;
  const rowH = measureLineRowHeight(ctx, line, inZone);

  // Group-zone backdrop — tint fill + continuous left rail under everything.
  if (zone) drawGroupMemberZone(page, zone, rowY, rowH);

  const style = lineOptionStyle(line, groupInfo);
  const ownCaption = drawsOwnCaption(line, inZone);
  const selectedFlag = zoneSelectedFlag(line, inZone);
  const captionBand = (ownCaption || selectedFlag) ? CAPTION_H : 0;
  const inner = rowH - ROW_TOP_PAD - ROW_BOTTOM_PAD - captionBand;
  const innerTop = rowY - ROW_TOP_PAD - captionBand;

  // ---- Image (same chrome as a normal row, top-aligned in the band) -----
  const img = await embedImageById(doc, line.imageId);
  // Top-align the image so the family + name header sits next to its
  // top edge — a centered image floating below the title looked
  // detached when the component list grew taller than the image.
  const imgY = innerTop - IMAGE_SIZE;
  drawProductImage(page, img, cols.img.x, imgY);

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

  // Swatch positions collected during the loop so they can be redrawn on
  // top if the whole compound row is later dimmed (non-selected alternative).
  const compSwatches: { id: string; topY: number }[] = [];

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
    const compTop = sy;
    sy = await drawComponentBlock(page, ctx, sy, cols, components[i], nameW);
    // The swatch top sits just below the component name (head); used to
    // redraw the swatch on top of any wash so its fabric colour stays vivid.
    const swatchTopY = compTop - compSegsHeight(componentDetail(ctx, components[i], cols.detail.w, nameW).head);
    if (componentSwatchShown(components[i])) {
      compSwatches.push({ id: components[i].swatchImageId as string, topY: swatchTopY });
    }
    // Optional components get the same treatment as the on-screen
    // preview: a dashed accent bar in the gutter + a white wash that
    // fades the block so it reads as an opt-in add-on, not part of the
    // base composition. The swatch is redrawn ON TOP so its colour shows.
    const compDimmed = components[i].isOptional
      || (!!components[i].alternativeGroup && !components[i].isSelectedAlternative);
    if (compDimmed) {
      drawComponentOptional(page, cols, compTop, sy);
      if (componentSwatchShown(components[i])) {
        await drawSwatch(page, ctx.doc, components[i].swatchImageId as string, cols.detail.x, swatchTopY, SWATCH_SIZE);
      }
    }
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
  // Material-less components make the compound a RANGE — "min – max" anchor,
  // same as a standalone range line; the discount strike is skipped then.
  const ranged = lineHasRange(line);
  const tr = ranged ? lineTotalRange(line) : null;

  if (!ranged && discount !== 0) {
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
  const compValText = tr ? `${fmt(tr.min)} – ${fmt(tr.max)}` : fmt(grandTotal);
  const compValSize = tr ? T.compTotalValue.size * 0.8 : T.compTotalValue.size;
  const totalValY = sy - compValSize;
  drawRightAt(
    page, compValText, cols.detail.rightX, totalValY,
    compValSize, fontBold, T.compTotalValue.color,
  );

  // ---- Option / alternative treatment ----------------------------------
  // Same finish as the article row — wash first; the per-row accent + caption
  // draw only when the row owns its caption (suppressed inside a zone, where
  // the rail + header band carry the identity).
  if (style) {
    if (style.dim) drawOptionDim(page, rowY, rowH);
    if (ownCaption) drawOptionAccent(page, ctx, style, rowY, rowH);
    // Redraw only the component swatches on top of the wash so their
    // fabric colours stay vivid in any state; the product photo dims with
    // the rest of a deactivated (optional / non-selected alternative) bundle.
    if (style.dim) {
      for (const s of compSwatches) {
        await drawSwatch(page, ctx.doc, s.id, cols.detail.x, s.topY, SWATCH_SIZE);
      }
    }
  }
  if (selectedFlag) drawSelectedFlag(page, ctx, rowY);

  // ---- Bottom divider ---------------------------------------------------
  // Suppressed inside a zone — the shaded container's tint + rail separate
  // members; a divider would cut it in two.
  const rowBottom = rowY - rowH;
  if (!zone) {
    page.drawLine({
      start: { x: MARGIN_L, y: rowBottom },
      end:   { x: PAGE_W - MARGIN_R, y: rowBottom },
      thickness: 0.5, color: INK_LINE2,
    });
  }

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
  const showSwatch = componentSwatchShown(component);
  if (showSwatch) {
    await drawSwatch(page, doc, component.swatchImageId as string, cols.detail.x, specTop, SWATCH_SIZE);
  }
  const specX = showSwatch ? cols.detail.x + SWATCH_SIZE + SWATCH_GAP : cols.detail.x;
  const afterSpec = drawCompSegs(page, ctx, cd.spec, specX, specTop);
  const specTextH = specTop - afterSpec;
  const specBlockH = showSwatch ? Math.max(SWATCH_SIZE, specTextH) : specTextH;
  sy = specTop - specBlockH;
  sy = drawCompSegs(page, ctx, cd.desc, cols.detail.x, sy);
  // Material-options grid below the component's description — same layout
  // as a standalone line, sharing the measure/draw helpers.
  const moCells = materialOptionCells(ctx, component.materialOptions, component.reference, component.swatchImageId, cols.detail.w);
  if (moCells.length) {
    sy = await drawMaterialOptions(page, ctx, moCells, cols.detail.x, sy, cols.detail.w);
  }
  return sy;
}
