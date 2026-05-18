import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  PAGE_W, PAGE_H, MARGIN_L, MARGIN_T, MARGIN_B,
} from './constants.js';
import { embedImageById } from './embed.js';
import { drawHeader, drawCustomerBlock } from './header.js';
import {
  drawLineRow, drawEmptyLineBody, drawSectionHeader, measureLineRowHeight,
} from './lines.js';
import { drawTotals, drawTerms, drawFooter, estimateTotalsHeight } from './totals.js';

/**
 * Generates a branded PDF quote that mirrors the on-screen ClientPreview.
 *
 *  - Page 1: company header → CLIENTE block → (section header → lines)*
 *  - Final page: totals + FX shadow + terms
 *  - Footer on every page: site URL + page X / Y
 *
 * One sequential pass: each draw function returns the next cursor.
 * Page breaks happen inline by comparing cursor.y to the bottom margin
 * plus a reserved height for the upcoming section.
 *
 * Lines are grouped by sections — a line with `kind: 'section'` doesn't
 * render as a line item; it prints a brand-color uppercase heading
 * ("MOBILIARIO DE SALA") and the lines after it sit under that heading
 * until the next section break (or end of list). Same grouping the
 * preview uses, so the output is visually identical.
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
  cursor = drawCustomerBlock(page, ctx, cursor);

  // ---- Lines, grouped by section ---------------------------------------
  // Same grouping algorithm the preview uses (lib in client-preview):
  // a 'section' line emits a heading and starts a new group.
  if (!lines.length) {
    cursor = drawEmptyLineBody(page, ctx, cursor);
  } else {
    const groups = groupBySection(lines);
    for (const group of groups) {
      // Reserve enough vertical space for the heading plus the first row
      // so we don't print a heading at the bottom of a page and orphan it.
      if (group.label) {
        const firstRowH = group.items.length
          ? measureLineRowHeight(ctx, group.items[0])
          : 0;
        const reserve = 22 + firstRowH;
        if (cursor.y - reserve < MARGIN_B + 80) {
          page = doc.addPage([PAGE_W, PAGE_H]);
          cursor = { x: MARGIN_L, y: PAGE_H - MARGIN_T };
        }
        cursor = drawSectionHeader(page, ctx, cursor, group.label);
      }
      for (const line of group.items) {
        const rowH = measureLineRowHeight(ctx, line);
        if (cursor.y - rowH - 4 < MARGIN_B + 80) {
          page = doc.addPage([PAGE_W, PAGE_H]);
          cursor = { x: MARGIN_L, y: PAGE_H - MARGIN_T };
        }
        cursor = await drawLineRow(page, ctx, cursor, line);
      }
    }
  }

  // ---- Totals + terms (kept together when they fit) --------------------
  const totalsHeight = estimateTotalsHeight(quote);
  if (cursor.y - totalsHeight < MARGIN_B + 60) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    cursor = { x: MARGIN_L, y: PAGE_H - MARGIN_T };
  }
  cursor = drawTotals(page, ctx, cursor, totals);
  if (quote.terms) cursor = drawTerms(page, ctx, cursor);

  // ---- Footer on every page --------------------------------------------
  const pageCount = doc.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    drawFooter(doc.getPage(i), ctx, i + 1, pageCount);
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

/**
 * Split lines into [{ label, items }] groups. Lines without a preceding
 * section sit in a leading null-label group. Matches the preview's
 * groupBySection() — keeping the two in lockstep means the PDF and the
 * web preview are visually identical for the customer.
 */
function groupBySection(lines) {
  const groups = [];
  let cur = { label: null, items: [] };
  for (const l of lines) {
    if (l.kind === 'section') {
      if (cur.items.length || cur.label) groups.push(cur);
      cur = { label: l.name || 'Sección', items: [] };
    } else {
      cur.items.push(l);
    }
  }
  if (cur.items.length || cur.label) groups.push(cur);
  return groups;
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
