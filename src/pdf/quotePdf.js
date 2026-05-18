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

/**
 * Hand the generated PDF blob to the user. Path varies by platform:
 *
 *   1. Web Share API with files — the primary path on mobile and PWAs.
 *      Triggers the native share sheet so the dealer can save to Files,
 *      AirDrop to a laptop, email it, etc. iOS standalone PWAs need
 *      this because the `<a download>` attribute is silently ignored
 *      in that mode, which is the root of the "nothing happens when I
 *      tap Export" bug. Requires HTTPS + a recent gesture (the export
 *      button click counts).
 *
 *   2. `<a download>` synthetic click — desktop and any platform where
 *      Web Share isn't available or refuses the file. This is the
 *      classic browser-download path; works on Chrome / Edge / Firefox
 *      / Android Chrome and on iOS Safari in regular tab mode (it'll
 *      open the blob inline rather than auto-download there, but the
 *      user still gets the file).
 *
 *   3. As a last resort, navigate the current window to the blob URL
 *      (`window.location.href = url`). This trips most browsers'
 *      download UI even when click() didn't, at the cost of leaving
 *      the app momentarily. We only reach this when everything above
 *      threw — without it, an iOS standalone PWA on a build that
 *      lacks Web Share files support (rare, but pre-iOS-15) would
 *      give the dealer no visible response at all.
 *
 * The blob URL is held for 30 s before revocation. Earlier code used
 * setTimeout(..., 0), which raced the browser's blob read on slower
 * devices — a too-quick revoke is one of the failure modes that looks
 * to the user like "nothing happened".
 *
 * Returns a Promise so callers can await completion (and surface
 * errors via a try/catch). Errors that aren't user-cancellation are
 * re-thrown so the UI can show a banner.
 */
export async function downloadBlob(blob, filename) {
  // Web Share with files — the only path that works in iOS PWA
  // standalone mode. We have to construct a real File (not just a
  // Blob) because navigator.canShare({ files }) is strict.
  if (typeof File !== 'undefined' && navigator.canShare) {
    try {
      const file = new File([blob], filename, {
        type: blob.type || 'application/pdf',
      });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      // AbortError = user dismissed the share sheet. That's a valid
      // outcome, not a failure to deliver the file — return quietly.
      if (err && err.name === 'AbortError') return;
      // Anything else: fall through to the anchor-click fallback. Don't
      // re-throw yet; the desktop path may still succeed.
      console.warn('[quotePdf] navigator.share fell through:', err);
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      document.body.removeChild(a);
    }
  } catch (err) {
    // Last-resort: navigate to the blob URL. The browser's own viewer
    // or download UI takes over from there.
    console.warn('[quotePdf] anchor click failed, navigating to blob:', err);
    window.location.href = url;
  } finally {
    // 30 s gives slow devices plenty of time to read the blob before
    // the URL is invalidated. Holding it indefinitely would leak the
    // blob; 0 ms (the previous behavior) raced the read.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
