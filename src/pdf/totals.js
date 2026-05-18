import { ITBIS_PCT } from '../lib/pricing.js';
import { effectiveDopRate } from '../lib/exchangeRate.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE, BG_SOFT,
} from './constants.js';
import { drawRightAt, formatMoney, formatPlain, wrapText } from './util.js';

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

// Rough vertical budget the totals block needs. Used by the page-break
// heuristic in generateQuotePdf to decide whether to push totals to a
// new page rather than splitting them off the last line row.
export function estimateTotalsHeight(quote) {
  let h = 24;            // top spacing
  h += 14 * 4;           // up to four subtotal-style rows (subtotal / discount / itbis / shipping)
  h += 10;               // divider + breathing
  h += 24;               // grand total row
  h += 18;               // FX shadow
  if (quote.terms) h += 90;
  return h;
}

export function drawTotals(page, ctx, cursor, totals) {
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
  const subRows = [['Subtotal', totals.subtotal, false]];
  if (quote.discountPct) {
    subRows.push([`Descuento (${quote.discountPct}%)`, -totals.discountAmt, true]);
  }
  subRows.push([`ITBIS (${ITBIS_PCT}%)`, totals.taxAmt, false]);
  if (quote.shipping) {
    subRows.push(['Envío', totals.shipping, false]);
  }

  for (const [label, value, muted] of subRows) {
    const labelColor = muted ? INK_MID : INK_HIGH;
    page.drawText(label, {
      x: leftX, y, size: 10, font: fontRegular, color: labelColor,
    });
    drawRightAt(
      page,
      formatMoney(value, currency, rates),
      rightX, y, 10, fontRegular, INK_HIGH,
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
export function drawTerms(page, ctx, cursor) {
  const { fontRegular, fontBold, quote } = ctx;
  let y = cursor.y - 8;
  page.drawText('TÉRMINOS Y CONDICIONES', {
    x: MARGIN_L, y, size: 7.5, font: fontBold, color: INK_MID,
    characterSpacing: 1.4,
  });
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
export function drawFooter(page, ctx, pageNum, pageCount) {
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

function siteUrlFromEmail(email) {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}
