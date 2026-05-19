import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
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
 * Typography pipeline
 * -------------------
 * The PDF embeds **Inter** (the same typeface the on-screen app uses)
 * via `@pdf-lib/fontkit`. Before this we relied on pdf-lib's built-in
 * Helvetica, which only supports WinAnsi (Latin-1) — any character
 * outside that range (`≈`, `–`, `…`, curly quotes, anything beyond
 * basic accented Latin) throws "WinAnsi cannot encode" mid-render and
 * the whole export aborts. With Inter embedded as a real TTF, the PDF
 * handles the full Unicode range Inter ships with: Latin, Latin
 * Extended, common punctuation, math symbols, etc.
 *
 * The font files live in `public/fonts/` (committed to the repo,
 * served as static assets) and are fetched once per export. Inter is
 * SIL-OFL licensed — we ship the LICENSE.txt alongside the binaries.
 *
 * Page layout (unchanged from the previous pass)
 * ----------------------------------------------
 *  - Page 1: company header → CLIENTE block → (section header → lines)*
 *  - Final page: totals + FX shadow + terms
 *  - Footer on every page: site URL + page X / Y
 */
export async function generateQuotePdf({ quote, settings, lines, totals, customer }) {
  const doc = await PDFDocument.create();

  // Register fontkit BEFORE any custom-font embedding. Without this
  // call, doc.embedFont(ttfBytes) throws "Input to PDFDocument.embedFont
  // must be a StandardFonts member" — the StandardFonts-only path is the
  // pdf-lib default to keep the bundle small; fontkit unlocks TTF/OTF.
  doc.registerFontkit(fontkit);

  // Fetch the three font weights in parallel. The trade-off vs caching
  // these on the window: PDF exports happen rarely (once per quote
  // delivery), so cold-loading ~1.2MB total per export keeps memory
  // pressure lower than holding the fonts resident forever. The browser
  // HTTP cache makes the second+ exports effectively free.
  const [regular, bold, italic] = await Promise.all([
    fetchFontBytes('/fonts/Inter-Regular.ttf'),
    fetchFontBytes('/fonts/Inter-Bold.ttf'),
    fetchFontBytes('/fonts/Inter-Italic.ttf'),
  ]);
  const fontRegular = await doc.embedFont(regular, { subset: true });
  const fontBold    = await doc.embedFont(bold,    { subset: true });
  const fontItalic  = await doc.embedFont(italic,  { subset: true });

  // `subset: true` tells fontkit to embed only the glyphs we actually
  // use. With three full Inter weights an unsubsetted PDF would carry
  // ~1.2 MB of fonts; subsetted, a typical 1-page quote PDF is
  // 30–80 KB total. Same fidelity, an order of magnitude smaller files.

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
  if (!lines.length) {
    cursor = drawEmptyLineBody(page, ctx, cursor);
  } else {
    const groups = groupBySection(lines);
    // Bottom-reserve constant for the line/section page-break checks.
    // The previous value (MARGIN_B + 80 = 136pt) was supposed to keep
    // "enough space for the next line or the totals" — but the totals
    // block has its own page-break check below (`estimateTotalsHeight`)
    // that's the authoritative gate, and lines are now ~200pt each
    // (quarter-page images). The old reserve was ejecting lines that
    // would otherwise fit by ~13pt, producing pages with one product
    // floating awkwardly above the totals block. Tight reserve here
    // means lines pack until they truly don't fit; totals overflow
    // cleanly onto their own page when they have to. Footer renders
    // at y=28 with a divider at y=42, so MARGIN_B + 10 leaves the
    // last line a comfortable 10pt above the footer hairline.
    const PAGE_BREAK_RESERVE = MARGIN_B + 10;
    for (const group of groups) {
      if (group.label) {
        const firstRowH = group.items.length
          ? measureLineRowHeight(ctx, group.items[0])
          : 0;
        const reserve = 22 + firstRowH;
        if (cursor.y - reserve < PAGE_BREAK_RESERVE) {
          page = doc.addPage([PAGE_W, PAGE_H]);
          cursor = { x: MARGIN_L, y: PAGE_H - MARGIN_T };
        }
        cursor = drawSectionHeader(page, ctx, cursor, group.label);
      }
      for (const line of group.items) {
        const rowH = measureLineRowHeight(ctx, line);
        if (cursor.y - rowH - 4 < PAGE_BREAK_RESERVE) {
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
  cursor = drawTotals(page, ctx, cursor, totals, lines);
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
 * Fetch a font file from /public and return its bytes as an
 * ArrayBuffer suitable for doc.embedFont. We use the absolute path
 * (`/fonts/...`) so it works regardless of where the SPA is mounted —
 * Vite serves public/ at the site root in both dev and production.
 *
 * Errors surface as an Error with a descriptive message so the
 * top-level try/catch in QuoteBuilder.exportPdf can show a banner
 * instead of letting the export silently fail mid-render.
 */
async function fetchFontBytes(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`No se pudo cargar la fuente ${url} (HTTP ${res.status}).`);
  }
  return res.arrayBuffer();
}

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
