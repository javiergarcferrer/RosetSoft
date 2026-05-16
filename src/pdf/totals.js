import { ITBIS_PCT } from '../lib/pricing.js';
import { effectiveDopRate, rateSourceLabel } from '../lib/exchangeRate.js';
import {
  PAGE_W, MARGIN_L, MARGIN_R,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE2,
} from './constants.js';
import { drawRightAt, formatMoney, formatPlain, wrapText } from './util.js';

/**
 * Rough vertical budget the totals block needs. Used by the page-break
 * heuristic in generateQuotePdf to decide whether to push totals to a new
 * page rather than splitting them off the last line row.
 */
export function estimateTotalsHeight(quote) {
  let h = 22;       // gap above
  h += 14 * 5;      // up to 5 subtotal rows
  h += 52;          // divider + ascent gap + grand total + spacing
  h += 50;          // DOP note
  if (quote.terms) h += 90;
  return h;
}

/**
 * Right-aligned totals panel: subtotals, divider, grand total, then a
 * quiet DOP-conversion note. Width and right edge fixed so the grand
 * total always sits in a consistent column on every quote.
 */
export function drawTotals(page, ctx, cursor, totals) {
  const { fontBold, fontRegular, quote } = ctx;
  const panelW = 280;
  const leftX = PAGE_W - MARGIN_R - panelW;
  const rightX = PAGE_W - MARGIN_R;
  let y = cursor.y - 22;

  const rows = [['Subtotal', totals.subtotal]];
  if (quote.marginPct) rows.push([`Margen (${quote.marginPct}%)`, totals.marginAmt]);
  if (quote.discountPct) rows.push([`Descuento (${quote.discountPct}%)`, -totals.discountAmt]);
  rows.push([`ITBIS (${ITBIS_PCT}%)`, totals.taxAmt]);
  if (quote.shipping) rows.push(['Envío', totals.shipping]);

  for (const [label, value] of rows) {
    page.drawText(label, { x: leftX, y, size: 9.5, font: fontRegular, color: INK_MID });
    drawRightAt(page, formatMoney(value, ctx.currency, ctx.rates), rightX, y, 9.5, fontRegular, INK_HIGH);
    y -= 14;
  }

  // Grand total + divider. We compute positions from font metrics so the
  // rule cannot accidentally clip the text — earlier passes derived the
  // divider from a magic offset, which left only ~8pt between the rule
  // and the cap-top of "$0.00".
  const totalLabelSize = 13;
  const totalValueSize = 14;          // value is a hair larger than the label
  const ascUnits = fontBold.heightAtSize(totalValueSize, { descender: false });
  const GAP_RULE_TO_TEXT = 10;        // visible breathing room above the cap-top
  const dividerThickness = 0.6;

  y -= 6;                              // breathing room below the subtotals
  const dividerY = y;
  const totalBaselineY =
    dividerY - dividerThickness / 2 - GAP_RULE_TO_TEXT - ascUnits;

  page.drawLine({
    start: { x: leftX, y: dividerY },
    end:   { x: rightX, y: dividerY },
    thickness: dividerThickness, color: INK,
  });
  page.drawText('Total', {
    x: leftX, y: totalBaselineY,
    size: totalLabelSize, font: fontBold, color: INK, characterSpacing: 0.2,
  });
  drawRightAt(
    page,
    formatMoney(totals.grandTotal, ctx.currency, ctx.rates),
    rightX, totalBaselineY, totalValueSize, fontBold, INK,
  );
  y = totalBaselineY - 24;

  // DOP conversion — a quiet secondary note rather than a boxed strip.
  // Top hairline groups it with the totals block; no fill keeps it from
  // competing with the grand total.
  const dopRate = effectiveDopRate(ctx.settings);
  const dopTotal = totals.grandTotal * dopRate;
  const rateLabel = rateSourceLabel(ctx.settings);
  page.drawLine({
    start: { x: leftX, y: y + 4 },
    end:   { x: rightX, y: y + 4 },
    thickness: 0.4, color: INK_LINE2,
  });
  page.drawText(`Tipo de cambio: 1 USD = ${dopRate.toFixed(2)} DOP`, {
    x: leftX, y: y - 8, size: 8, font: fontRegular, color: INK_MID,
  });
  page.drawText(`(${rateLabel})`, {
    x: leftX, y: y - 19, size: 7.5, font: fontRegular, color: INK_SOFT,
  });
  page.drawText('Total RD$', { x: leftX, y: y - 33, size: 10, font: fontBold, color: INK_HIGH });
  drawRightAt(page, `RD$ ${formatPlain(dopTotal)}`, rightX, y - 33, 11, fontBold, INK);
  y -= 50;

  return { x: MARGIN_L, y };
}

/** Multi-line terms block at the bottom of the last page. */
export function drawTerms(page, ctx, cursor) {
  const { fontRegular, fontBold, quote } = ctx;
  let y = cursor.y - 4;
  page.drawText('TÉRMINOS Y CONDICIONES', { x: MARGIN_L, y, size: 7, font: fontBold, color: INK_MID, characterSpacing: 1.2 });
  y -= 14;
  const lines = wrapText(quote.terms || '', 95);
  for (const ln of lines) {
    page.drawText(ln, { x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_HIGH });
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
    end: { x: PAGE_W - MARGIN_R, y: y + 14 },
    thickness: 0.4, color: INK_LINE2,
  });
  const footerLeft = settings.quoteFooter || siteUrlFromEmail(settings.companyEmail) || settings.companyName || '';
  if (footerLeft) {
    page.drawText(footerLeft, { x: MARGIN_L, y, size: 8, font: fontRegular, color: INK_MID });
  }
  const pageText = `${pageNum} / ${pageCount}`;
  drawRightAt(page, pageText, PAGE_W - MARGIN_R, y, 8, fontRegular, INK_MID);
}

function siteUrlFromEmail(email) {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}
