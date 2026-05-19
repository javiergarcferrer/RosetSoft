import type { PDFPage, PDFImage, PDFFont } from 'pdf-lib';
import {
  PAGE_W, PAGE_H, MARGIN_L, MARGIN_R, MARGIN_T,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE,
} from './constants.js';
import type { PdfCtx, Cursor } from './types.js';
import type { DrawTextOptions } from './util.js';

/**
 * Page-1 header. Mirrors the on-screen ClientPreview the dealer shows
 * during a sales conversation:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │                                                          │
 *   │ ALCOVER                              COTIZACIÓN          │
 *   │                                      #1001               │
 *   │ Address line                                             │
 *   │ Phone                                May 17, 2026        │
 *   │ Email                                                    │
 *   │                                                          │
 *   ├─────────────────────────────────────────────────────────│
 *   │                                                          │
 *   │ CLIENTE                                                  │
 *   │ Eduardo Garcia                                           │
 *   │ ...                                                      │
 *   │                                                          │
 *   └─────────────────────────────────────────────────────────┘
 *
 * No "FECHA · VÁLIDA HASTA · ESTADO · MONEDA" meta band — that strip
 * existed in older revisions and got dropped from the preview design,
 * so the PDF dropped it too. No brand-color underline under the
 * number — the preview doesn't have it either. The whole intent is:
 * what the dealer shows on screen is what the customer sees in PDF.
 */

const COMPANY_FONT_SIZE = 26;   // matches the preview's "ALCOVER" wordmark scale
const NUMBER_FONT_SIZE  = 26;
const EYEBROW_SIZE      = 8;
const EYEBROW_TRACKING  = 1.4;

function fontItalicOrRegular(ctx: PdfCtx): PDFFont {
  return ctx.fontItalic || ctx.fontRegular;
}

/**
 * Draw the company-and-quote-number header block. Returns the cursor
 * (left margin, y just under the bottom of the header) for the next
 * renderer.
 */
export function drawHeader(page: PDFPage, ctx: PdfCtx, logoImage: PDFImage | null): Cursor {
  const { fontBold, fontRegular, settings, quote } = ctx;
  const top = PAGE_H - MARGIN_T;

  // -------- left side: company wordmark + address ---------------------------
  // Show the uploaded logo when present (it usually *is* the wordmark);
  // otherwise typeset the company name at COMPANY_FONT_SIZE.
  let leftBottomY: number;
  if (logoImage) {
    const maxH = 36;
    const maxW = 200;
    const scale = Math.min(maxH / logoImage.height, maxW / logoImage.width);
    const w = logoImage.width * scale;
    const h = logoImage.height * scale;
    page.drawImage(logoImage, { x: MARGIN_L, y: top - h, width: w, height: h });
    leftBottomY = top - h - 14;
  } else {
    page.drawText(settings.companyName || 'Tu empresa', {
      x: MARGIN_L, y: top - COMPANY_FONT_SIZE,
      size: COMPANY_FONT_SIZE, font: fontBold, color: INK,
    });
    leftBottomY = top - COMPANY_FONT_SIZE - 18;
  }

  // Address / phone / email — one line each, muted, tight rhythm.
  const addressLines = [
    settings.companyAddress,
    settings.companyPhone,
    settings.companyEmail,
  ].filter(Boolean) as string[];
  let ay = leftBottomY;
  for (const ln of addressLines) {
    page.drawText(ln, { x: MARGIN_L, y: ay, size: 9, font: fontRegular, color: INK_MID });
    ay -= 12;
  }

  // -------- right side: COTIZACIÓN eyebrow + #number + date ----------------
  // All three are right-aligned to MARGIN_R. The eyebrow sits at the top,
  // the big number directly below, then the date in muted text under the
  // number — same hierarchy as the preview's right column.
  const rightX = PAGE_W - MARGIN_R;
  const numbered = quote.number != null && (quote.number as unknown as string) !== '';

  // Eyebrow
  const eyebrow = 'COTIZACIÓN';
  const eyebrowW = fontRegular.widthOfTextAtSize(eyebrow, EYEBROW_SIZE)
                 + EYEBROW_TRACKING * (eyebrow.length - 1);
  page.drawText(eyebrow, {
    x: rightX - eyebrowW,
    y: top - EYEBROW_SIZE,
    size: EYEBROW_SIZE, font: fontRegular, color: INK_MID,
    characterSpacing: EYEBROW_TRACKING,
  } as DrawTextOptions);

  // Big #number (or BORRADOR when unnumbered — better than "# —")
  const numText = numbered ? `#${quote.number}` : 'BORRADOR';
  const numSize = numbered ? NUMBER_FONT_SIZE : 20;
  const numW = fontBold.widthOfTextAtSize(numText, numSize);
  const numY = top - EYEBROW_SIZE - 10 - numSize;
  page.drawText(numText, {
    x: rightX - numW,
    y: numY,
    size: numSize, font: fontBold, color: INK,
  });

  // Date — muted, sits beneath the number, right-aligned
  const dateStr = new Date(quote.createdAt || Date.now())
    .toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' });
  const dateW = fontRegular.widthOfTextAtSize(dateStr, 10);
  page.drawText(dateStr, {
    x: rightX - dateW,
    y: numY - 18,
    size: 10, font: fontRegular, color: INK_MID,
  });

  // The header's content extent on either side — pick the deeper of the
  // two so the divider sits below all of it with consistent breathing room.
  const headerBottom = Math.min(ay + 2, numY - 24);
  page.drawLine({
    start: { x: MARGIN_L, y: headerBottom - 6 },
    end:   { x: rightX,   y: headerBottom - 6 },
    thickness: 0.5, color: INK_LINE,
  });

  return { x: MARGIN_L, y: headerBottom - 22 };
}

/**
 * Client / customer block. Single column on the left:
 *
 *     CLIENTE                ← eyebrow
 *     Eduardo Garcia         ← name, bold
 *     Acme Studio            ← company, lighter
 *     address line 1
 *     city, state · email · phone
 *
 * Falls back to italic "Sin cliente asignado" so the layout doesn't
 * collapse on draft quotes.
 */
export function drawCustomerBlock(page: PDFPage, ctx: PdfCtx, cursor: Cursor): Cursor {
  const { fontBold, fontRegular, customer } = ctx;
  const y0 = cursor.y;

  page.drawText('CLIENTE', {
    x: MARGIN_L, y: y0,
    size: EYEBROW_SIZE, font: fontRegular, color: INK_MID,
    characterSpacing: EYEBROW_TRACKING,
  } as DrawTextOptions);

  let y = y0 - 18;
  if (customer) {
    page.drawText(customer.name || '—', {
      x: MARGIN_L, y, size: 13, font: fontBold, color: INK,
    });
    y -= 16;
    if (customer.company) {
      page.drawText(customer.company, {
        x: MARGIN_L, y, size: 10, font: fontRegular, color: INK_HIGH,
      });
      y -= 13;
    }
    // Address as one or two lines; city/state/zip on the same line.
    const addressLine = [customer.address].filter(Boolean).join('');
    if (addressLine) {
      page.drawText(addressLine, {
        x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_MID,
      });
      y -= 12;
    }
    const meta = [
      [customer.city, customer.state, customer.zip].filter(Boolean).join(', '),
      customer.country,
      customer.email,
      customer.phone,
    ].filter(Boolean).join(' · ');
    if (meta) {
      page.drawText(meta, {
        x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_MID,
      });
      y -= 12;
    }
  } else {
    page.drawText('Sin cliente asignado', {
      x: MARGIN_L, y, size: 11, font: fontItalicOrRegular(ctx), color: INK_SOFT,
    });
    y -= 14;
  }

  // Hairline divider below the customer block — same treatment as the
  // header divider, so the page has a consistent letterhead rhythm.
  const dividerY = y - 4;
  page.drawLine({
    start: { x: MARGIN_L, y: dividerY },
    end:   { x: PAGE_W - MARGIN_R, y: dividerY },
    thickness: 0.5, color: INK_LINE,
  });
  return { x: MARGIN_L, y: dividerY - 18 };
}
