import type { PDFPage, PDFFont, RGB } from 'pdf-lib';
import type { Quote, QuoteLine, Totals } from '../types/domain.ts';
import { ITBIS_PCT, quoteSavings, computeTotalsRange } from '../lib/pricing.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R,
  INK_HIGH, INK_MID, INK_LINE, BRAND_700,
  BAND_INK, BAND_CREAM, WHITE,
  FS_TOTAL_BIG, FS_BODY, FS_META, FS_EYEBROW_SM,
} from './constants.js';
import { drawRightAt, formatMoney, formatPlain, wrapText } from './util.js';
import type { DrawTextOptions } from './util.js';
import type { PdfCtx, Cursor } from './types.js';

/**
 * Right-aligned totals panel — mirrors the ClientPreview structure:
 *
 *     Subtotal               $22,620.00
 *     Descuento (10%)        –$2,262.00      ← only if discount set
 *     ITBIS (18%)             $4,071.60
 *     Envío                     $250.00      ← only if shipping set
 *    ─────────────────────────────────────
 *     Total                  $26,691.60
 *     ≈ RD$ 1,576,686 a 59.07 DOP/USD          ← inline FX shadow
 *
 * No "Tipo de cambio · rate source · Total RD$" block from the old PDF.
 * That whole block was replaced by the single inline `≈ RD$ … a … DOP/USD`
 * line at the bottom — the preview shows it that way and the dealer
 * specifically asked for the export to match the preview.
 */

// Tone discriminator for the subtotal-stack rows. Drives both color
// (default/muted/accent) and font weight (bold for the brand-accented
// discount row, regular for the rest).
type SubRowTone = 'default' | 'muted' | 'accent';
type SubRow = [string, number, SubRowTone];

// Rough vertical budget the totals block needs. Used by the page-break
// heuristic in generateQuotePdf to decide whether to push totals to a
// new page rather than splitting them off the last line row.
// Geometry of the anchored grand-total band — the headline of the
// redesign. Kept as named constants so estimateTotalsHeight and
// drawTotals can't drift.
const BAND_W   = 300;   // right-aligned block width
const BAND_H   = 46;    // band height
const BAND_PAD = 16;    // inner horizontal padding (label / value insets)
const SUB_ROW_LH = 15;  // line-height of each subtotal-stack row

export function estimateTotalsHeight(quote: Quote): number {
  let h = 22;                 // top spacing before the sub-rows
  h += SUB_ROW_LH * 4;        // up to four subtotal rows (subtotal / discount / itbis / shipping)
  h += 12;                    // breathing before the band
  h += BAND_H;                // the grand-total band
  h += 18;                    // "Ahorras $X" callout (when any discount is set)
  h += 18;                    // FX shadow
  h += 10;                    // trailing breathing
  if (quote.terms) h += 90;
  return h;
}

export function drawTotals(
  page: PDFPage,
  ctx: PdfCtx,
  cursor: Cursor,
  totals: Totals,
  lines: QuoteLine[],
): Cursor {
  const { fontBold, fontRegular, quote, currency, rates } = ctx;
  const leftX = PAGE_W - MARGIN_R - BAND_W;
  const rightX = PAGE_W - MARGIN_R;

  let y = cursor.y - 22;

  // ---- Subtotal stack ----
  // Right-aligned supporting cast above the band. Body text (~9.5pt);
  // the discount row reads in brand-700 so the customer perceives the
  // concession instead of it fading into the ITBIS / Envío rows.
  const subRows: SubRow[] = [['Subtotal', totals.subtotal, 'default']];
  if (quote.discountPct) {
    subRows.push([`Descuento (${quote.discountPct}%)`, -totals.discountAmt, 'accent']);
  }
  subRows.push([`ITBIS (${ITBIS_PCT}%)`, totals.taxAmt, 'muted']);
  if (quote.shipping) {
    subRows.push(['Envío', totals.shipping, 'muted']);
  }

  for (const [label, value, tone] of subRows) {
    const color: RGB = tone === 'accent' ? BRAND_700
      : tone === 'muted' ? INK_MID
      : INK_HIGH;
    const font: PDFFont = tone === 'accent' ? fontBold : fontRegular;
    page.drawText(label, {
      x: leftX, y, size: FS_BODY, font, color,
    });
    drawRightAt(
      page,
      formatMoney(value, currency, rates),
      rightX, y, FS_BODY, font, color,
    );
    y -= SUB_ROW_LH;
  }

  // ---- The anchored grand-total band — the visual climax ---------------
  // A solid near-black bar spans the right BAND_W. "TOTAL" reads in a
  // muted cream tone on the left inside the band; the grand-total value
  // in WHITE at 24pt bold on the right. Far heavier than any line total,
  // so the eye lands here first.
  y -= 12;                       // breathing between sub-rows and the band
  const bandTop = y;
  const bandBottom = bandTop - BAND_H;
  page.drawRectangle({
    x: leftX, y: bandBottom, width: BAND_W, height: BAND_H, color: BAND_INK,
  });

  // Vertically center both label + value on the band. Use the value's
  // cap height (24pt) as the dominant element to find the baseline.
  const valueAsc = fontBold.heightAtSize(FS_TOTAL_BIG, { descender: false });
  const valueBaseline = bandBottom + (BAND_H - valueAsc) / 2;
  // "TOTAL" label — cream, left inside the band, optically aligned to
  // the value's vertical center.
  const labelText = 'TOTAL';
  const labelSize = FS_EYEBROW_SM;
  const labelAsc = fontBold.heightAtSize(labelSize, { descender: false });
  const labelBaseline = bandBottom + (BAND_H - labelAsc) / 2;
  page.drawText(labelText, {
    x: leftX + BAND_PAD, y: labelBaseline,
    size: labelSize, font: fontBold, color: BAND_CREAM,
    characterSpacing: 2,
  } as DrawTextOptions);
  // Grand total — a RANGE while any priced line is material-less; shrink the
  // headline size until the wider "min – max" string clears the TOTAL label.
  const range = computeTotalsRange(lines || [], quote);
  const hasRange = range.max > range.min;
  if (hasRange) {
    const rangeText = `${formatMoney(range.min, currency, rates)} – ${formatMoney(range.max, currency, rates)}`;
    const labelW = fontBold.widthOfTextAtSize(labelText, labelSize);
    const avail = BAND_W - BAND_PAD * 2 - labelW - 10;
    let size = FS_TOTAL_BIG;
    while (size > 9 && fontBold.widthOfTextAtSize(rangeText, size) > avail) size -= 0.5;
    const asc = fontBold.heightAtSize(size, { descender: false });
    drawRightAt(page, rangeText, rightX - BAND_PAD, bandBottom + (BAND_H - asc) / 2, size, fontBold, WHITE);
  } else {
    drawRightAt(
      page,
      formatMoney(totals.grandTotal, currency, rates),
      rightX - BAND_PAD, valueBaseline, FS_TOTAL_BIG, fontBold, WHITE,
    );
  }
  y = bandBottom - 14;

  // ---- "Ahorras $X" callout (below the band, right-aligned) -----------
  // Aggregates per-line discounts + the quote-level discount into one
  // figure so the customer perceives the full concession. Brand-700 so
  // it reads as the savings line, mirroring the on-screen ClientPreview.
  const savings = quoteSavings(lines || [], totals);
  if (savings > 0) {
    const text = `Ahorras ${formatMoney(savings, currency, rates)} en esta cotización`;
    drawRightAt(page, text, rightX, y - FS_BODY, FS_BODY, fontBold, BRAND_700);
    y -= 18;
  }

  // ---- Inline FX shadow (below the savings line, muted ink) -----------
  // Single muted line: "≈ RD$ 1,576,686 a 59.07 DOP/USD". Use the rate
  // already resolved for this quote (locked snapshot once sent, live
  // while a draft) so this FX line agrees with the band above it.
  const dopRate = Number(rates?.DOP) || 0;
  if (dopRate && currency === 'USD') {
    const fx = hasRange
      ? `≈ RD$ ${formatPlain(range.min * dopRate)} – ${formatPlain(range.max * dopRate)} a ${dopRate.toFixed(2)} DOP/USD`
      : `≈ RD$ ${formatPlain(totals.grandTotal * dopRate)} a ${dopRate.toFixed(2)} DOP/USD`;
    drawRightAt(page, fx, rightX, y - FS_META, FS_META, fontRegular, INK_MID);
    y -= 20;
  } else {
    y -= 6;
  }

  return { x: MARGIN_L, y };
}

/** Multi-line terms block at the bottom of the last page. */
export function drawTerms(page: PDFPage, ctx: PdfCtx, cursor: Cursor): Cursor {
  const { fontRegular, fontBold, quote } = ctx;
  let y = cursor.y - 8;
  page.drawText('TÉRMINOS Y CONDICIONES', {
    x: MARGIN_L, y, size: 7.5, font: fontBold, color: INK_MID,
    characterSpacing: 1.4,
  } as DrawTextOptions);
  y -= 14;
  const lines = wrapText(quote.terms || '', 95);
  for (const ln of lines) {
    page.drawText(ln, {
      x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_HIGH,
    });
    y -= 12;
  }
  return { x: MARGIN_L, y: y - 6 };
}

/** Per-page footer: company line on the left, "page N / M" on the right. */
export function drawFooter(page: PDFPage, ctx: PdfCtx, pageNum: number, pageCount: number): void {
  const { fontRegular, settings } = ctx;
  const y = 28;
  page.drawLine({
    start: { x: MARGIN_L, y: y + 14 },
    end:   { x: PAGE_W - MARGIN_R, y: y + 14 },
    thickness: 0.4, color: INK_LINE,
  });
  const footerLeft = settings.quoteFooter
    || siteUrlFromEmail(settings.companyEmail)
    || settings.companyName || '';
  if (footerLeft) {
    page.drawText(footerLeft, {
      x: MARGIN_L, y, size: 8, font: fontRegular, color: INK_MID,
    });
  }
  const pageText = `${pageNum} / ${pageCount}`;
  drawRightAt(page, pageText, PAGE_W - MARGIN_R, y, 8, fontRegular, INK_MID);
}

function siteUrlFromEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}
