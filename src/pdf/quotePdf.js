import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  PAGE_W, PAGE_H, MARGIN_L, MARGIN_T, MARGIN_B, LINE_ROW_RESERVED,
} from './constants.js';
import { embedImageById } from './embed.js';
import { drawHeader, drawQuoteMeta, drawCustomerBlock } from './header.js';
import { drawLineHeader, drawLineRow, drawEmptyLineBody } from './lines.js';
import { drawTotals, drawTerms, drawFooter, estimateTotalsHeight } from './totals.js';

/**
 * Generates a branded PDF quote.
 *
 *  - Page 1+: header + meta + customer/project + line items
 *  - Final page: totals + DOP conversion + terms
 *  - Footer on every page: site URL + page X / Y
 *
 * The renderer is a single sequential pass: each draw function returns the
 * cursor (current x/y) for the next renderer. Page breaks happen inline by
 * comparing cursor.y to the bottom margin plus a per-section reserved height.
 */
export async function generateQuotePdf({ quote, settings, lines, totals, customer }) {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const ctx = {
    doc,
    fontRegular,
    fontBold,
    fontItalic,
    settings: settings || {},
    quote,
    customer,
    rates: quote.rates || { USD: 1 },
    currency: quote.currencyCode || 'USD',
  };

  const logoImage = await embedImageById(doc, settings?.logoImageId);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let cursor = drawHeader(page, ctx, logoImage);
  cursor = drawQuoteMeta(page, ctx, cursor);
  cursor = drawCustomerBlock(page, ctx, cursor);

  cursor = drawLineHeader(page, ctx, cursor);

  if (!lines.length) {
    cursor = drawEmptyLineBody(page, ctx, cursor);
  } else {
    for (const line of lines) {
      // LINE_ROW_RESERVED slightly exceeds the actual row height so we wrap
      // to a new page a hair before a row would clip the bottom margin.
      if (cursor.y - LINE_ROW_RESERVED < MARGIN_B + 80) {
        page = doc.addPage([PAGE_W, PAGE_H]);
        cursor = { x: MARGIN_L, y: PAGE_H - MARGIN_T };
        cursor = drawLineHeader(page, ctx, cursor);
      }
      cursor = await drawLineRow(page, ctx, cursor, line);
    }
  }

  // Totals + terms — keep them together if they fit.
  const totalsHeight = estimateTotalsHeight(quote);
  if (cursor.y - totalsHeight < MARGIN_B + 60) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    cursor = { x: MARGIN_L, y: PAGE_H - MARGIN_T };
  }
  cursor = drawTotals(page, ctx, cursor, totals);
  if (quote.terms) cursor = drawTerms(page, ctx, cursor);

  // Footer on every page
  const pageCount = doc.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    drawFooter(doc.getPage(i), ctx, i + 1, pageCount);
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

/** Trigger a browser download for a blob produced by generateQuotePdf. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
