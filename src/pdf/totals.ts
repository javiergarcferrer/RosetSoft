import type { PDFPage, PDFFont, RGB } from 'pdf-lib';
import type { Quote, QuoteLine, Totals } from '../types/domain.ts';
import { ITBIS_PCT, quoteSavings } from '../lib/pricing.js';
import { effectiveDopRate } from '../lib/exchangeRate.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, BG_SOFT, BRAND_700,
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
export function estimateTotalsHeight(quote: Quote): number {
  let h = 24;            // top spacing
  h += 14 * 4;           // up to four subtotal-style rows (subtotal / discount / itbis / shipping)
  h += 10;               // divider + breathing
  h += 24;               // grand total row
  h += 16;               // "Ahorras $X" callout (when any discount is set)
  h += 18;               // FX shadow
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
  const { fontBold, fontRegular, quote, settings, currency, rates } = ctx;
  const panelW = 300;
  const leftX = PAGE_W - MARGIN_R - panelW;
  const rightX = PAGE_W - MARGIN_R;

  // A subtle tinted band behind the totals — same treatment as the
  // preview, where the totals section sits on a soft ink-50 panel.
  // Geometry: starts at cursor.y, runs down to just under the FX
  // shadow. We pre-measure to keep the band's bottom edge accurate.
  let y = cursor.y - 22;
  const bandTop = cursor.y - 4;

  // ---- Subtotal stack ----
  // tone: 'default' | 'muted' | 'accent' — the discount row reads in
  // brand-700 so the customer perceives it, instead of fading into
  // the ITBIS / Envío supporting cast.
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
      x: leftX, y, size: 10, font, color,
    });
    drawRightAt(
      page,
      formatMoney(value, currency, rates),
      rightX, y, 10, font, color,
    );
    y -= 16;
  }

  // ---- Divider above grand total ----
  y -= 4;
  page.drawLine({
    start: { x: leftX, y },
    end:   { x: rightX, y },
    thickness: 0.6, color: INK,
  });
  y -= 10;

  // ---- Grand total ----
  const totalLabelSize = 13;
  const totalValueSize = 15;
  const ascUnits = fontBold.heightAtSize(totalValueSize, { descender: false });
  const totalBaselineY = y - ascUnits;
  page.drawText('Total', {
    x: leftX, y: totalBaselineY,
    size: totalLabelSize, font: fontBold, color: INK,
  });
  drawRightAt(
    page,
    formatMoney(totals.grandTotal, currency, rates),
    rightX, totalBaselineY, totalValueSize, fontBold, INK,
  );
  y = totalBaselineY - 10;

  // ---- "Ahorras $X" callout -------------------------------------------
  // Aggregates per-line discounts + the quote-level discount into one
  // figure so the customer perceives the full concession, not just the
  // post-discount numbers. Mirrors the on-screen ClientPreview's
  // "Ahorras X en esta cotización" line.
  const savings = quoteSavings(lines || [], totals);
  if (savings > 0) {
    const text = `Ahorras ${formatMoney(savings, currency, rates)} en esta cotización`;
    drawRightAt(page, text, rightX, y - 9, 9, fontBold, BRAND_700);
    y -= 16;
  }

  // ---- Inline FX shadow ----
  // Single muted line: "≈ RD$ 1,576,686 a 59.07 DOP/USD". Replaces the
  // verbose "Tipo de cambio / source / Total RD$" stack — preview shows
  // just the shadow and we mirror it.
  const dopRate = effectiveDopRate(settings);
  if (dopRate && currency === 'USD') {
    const dopTotal = totals.grandTotal * dopRate;
    const fx = `≈ RD$ ${formatPlain(dopTotal)} a ${dopRate.toFixed(2)} DOP/USD`;
    drawRightAt(page, fx, rightX, y - 8, 9, fontRegular, INK_MID);
    y -= 22;
  } else {
    y -= 4;
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
