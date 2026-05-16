import {
  PAGE_W, PAGE_H, MARGIN_L, MARGIN_R, MARGIN_T, CONTENT_W,
  INK, INK_HIGH, INK_MID, INK_SOFT, INK_LINE2, ACCENT,
} from './constants.js';
import { truncate } from './util.js';

/** Italic if available, regular otherwise — keeps the "Sin cliente" fallback readable. */
function fontItalicOrRegular(ctx) {
  return ctx.fontItalic || ctx.fontRegular;
}

/** Best-effort "valid until" date — 30 days after creation. */
export function validUntil(quote) {
  const created = quote.createdAt || Date.now();
  return new Date(created + 30 * 86400 * 1000).toLocaleDateString('es-DO');
}

/**
 * Draw the page-1 header: logo (or company wordmark) + address block on the
 * left; right side carries an uppercase COTIZACIÓN label, the quote number
 * (or "BORRADOR"), and a brand-color underline.
 */
export function drawHeader(page, ctx, logoImage) {
  const { fontBold, fontRegular, settings } = ctx;
  const top = PAGE_H - MARGIN_T;

  // Left side: logo OR companyName (never both — the logo usually IS the
  // wordmark). Address/contact go beneath in muted small caps.
  // The wordmark sits at ~28pt cap-height; bigger reads as a banner, not
  // letterhead, and amplifies any rasterization roughness in the user's image.
  let leftBottomY = top;
  if (logoImage) {
    const maxH = 28;
    const maxW = 140;
    const scale = Math.min(maxH / logoImage.height, maxW / logoImage.width);
    const w = logoImage.width * scale;
    const h = logoImage.height * scale;
    page.drawImage(logoImage, { x: MARGIN_L, y: top - h, width: w, height: h });
    leftBottomY = top - h - 8;
  } else {
    page.drawText(settings.companyName || 'Your Company', {
      x: MARGIN_L, y: top - 20, size: 20, font: fontBold, color: INK,
      characterSpacing: 0.4,
    });
    leftBottomY = top - 30;
  }

  const addressLines = [
    settings.companyAddress,
    [settings.companyPhone, settings.companyEmail].filter(Boolean).join(' · '),
  ].filter(Boolean);
  let ay = leftBottomY;
  for (const ln of addressLines) {
    page.drawText(ln, { x: MARGIN_L, y: ay, size: 8.5, font: fontRegular, color: INK_MID });
    ay -= 11;
  }

  // Right side: small uppercase label + big quote number (or "BORRADOR"
  // when the quote hasn't been numbered yet — better than rendering "# —").
  const numbered = ctx.quote.number != null && ctx.quote.number !== '';
  const labelText = 'COTIZACIÓN';
  const labelSize = 8;
  const labelSpacing = 1.6;
  // widthOfTextAtSize ignores characterSpacing — add it back for right-alignment.
  const labelW = fontRegular.widthOfTextAtSize(labelText, labelSize) + labelSpacing * (labelText.length - 1);
  page.drawText(labelText, {
    x: PAGE_W - MARGIN_R - labelW,
    y: top - labelSize,
    size: labelSize,
    font: fontRegular,
    color: INK_MID,
    characterSpacing: labelSpacing,
  });

  const numText = numbered ? `#${ctx.quote.number}` : 'BORRADOR';
  const numSize = numbered ? 26 : 20;
  const numW = fontBold.widthOfTextAtSize(numText, numSize);
  page.drawText(numText, {
    x: PAGE_W - MARGIN_R - numW,
    y: top - labelSize - 8 - numSize,
    size: numSize,
    font: fontBold,
    color: INK,
  });
  // Brand-color underline under the number
  page.drawRectangle({
    x: PAGE_W - MARGIN_R - numW,
    y: top - labelSize - 8 - numSize - 6,
    width: numW,
    height: 2,
    color: ACCENT,
  });

  return { x: MARGIN_L, y: top - 92 };
}

/**
 * Meta band beneath the header: FECHA · VÁLIDA HASTA · ESTADO · MONEDA.
 * Top + bottom hairlines, no fill — reads as letterhead-typography rather
 * than a chip strip.
 */
export function drawQuoteMeta(page, ctx, cursor) {
  const { fontBold, fontRegular, quote } = ctx;
  // MONEDA: when the display currency IS USD don't repeat it ("USD · USD"
  // looked silly). Show just the code; for any other code (e.g. DOP) show
  // "DOP / USD" to make the conversion-target relationship explicit.
  const moneda = ctx.currency === 'USD' ? 'USD' : `${ctx.currency} / USD`;
  const cols = [
    ['FECHA', new Date(quote.createdAt || Date.now()).toLocaleDateString('es-DO')],
    ['VÁLIDA HASTA', validUntil(quote)],
    ['ESTADO', (quote.status || 'borrador').toUpperCase()],
    ['MONEDA', moneda],
  ];

  const bandH = 44;
  const bandTop = cursor.y + 8;
  const bandBottom = bandTop - bandH;
  page.drawLine({
    start: { x: MARGIN_L, y: bandTop },
    end:   { x: PAGE_W - MARGIN_R, y: bandTop },
    thickness: 0.5, color: INK_LINE2,
  });
  page.drawLine({
    start: { x: MARGIN_L, y: bandBottom },
    end:   { x: PAGE_W - MARGIN_R, y: bandBottom },
    thickness: 0.5, color: INK_LINE2,
  });

  const colW = CONTENT_W / cols.length;
  cols.forEach(([label, value], i) => {
    const x = MARGIN_L + i * colW;
    page.drawText(label, { x, y: cursor.y - 6, size: 7, font: fontRegular, color: INK_MID, characterSpacing: 1.2 });
    page.drawText(value, { x, y: cursor.y - 22, size: 11, font: fontBold, color: INK });
  });
  return { x: MARGIN_L, y: cursor.y - bandH - 16 };
}

/**
 * Two-column block: customer details on the left, project name on the right.
 * When `customer` is null, fall back to an italic "Sin cliente asignado" so
 * the layout doesn't collapse on draft quotes.
 */
export function drawCustomerBlock(page, ctx, cursor) {
  const { fontBold, fontRegular, customer, quote } = ctx;
  const y0 = cursor.y;

  // Left column: customer
  page.drawText('PREPARADO PARA', { x: MARGIN_L, y: y0, size: 7, font: fontRegular, color: INK_MID, characterSpacing: 1.2 });
  let y = y0 - 14;
  if (customer) {
    page.drawText(customer.name || '—', { x: MARGIN_L, y, size: 12, font: fontBold, color: INK }); y -= 14;
    if (customer.company) { page.drawText(customer.company, { x: MARGIN_L, y, size: 9.5, font: fontRegular, color: INK_HIGH }); y -= 11; }
    const addrLines = [customer.address, [customer.city, customer.state, customer.zip].filter(Boolean).join(', '), customer.country].filter(Boolean);
    for (const a of addrLines) { page.drawText(a, { x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_MID }); y -= 11; }
    const contact = [customer.email, customer.phone].filter(Boolean).join(' · ');
    if (contact) { page.drawText(contact, { x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_MID }); y -= 11; }
  } else {
    page.drawText('Sin cliente asignado', { x: MARGIN_L, y, size: 11, font: fontItalicOrRegular(ctx), color: INK_SOFT });
    y -= 12;
  }

  // Right column: project
  if (quote.name) {
    page.drawText('PROYECTO', { x: MARGIN_L + CONTENT_W / 2, y: y0, size: 7, font: fontRegular, color: INK_MID, characterSpacing: 1.2 });
    page.drawText(truncate(quote.name, 38), {
      x: MARGIN_L + CONTENT_W / 2,
      y: y0 - 14, size: 12, font: fontBold, color: INK,
    });
  }

  const bottom = Math.min(y, y0 - 28);
  return { x: MARGIN_L, y: bottom - 18 };
}
