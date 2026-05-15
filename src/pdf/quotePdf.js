import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { downloadImageBytes } from '../db/database.js';
import { applyLineAdjustments, ITBIS_PCT } from '../lib/pricing.js';
import { effectiveDopRate, rateSourceLabel } from '../lib/exchangeRate.js';

/**
 * Generates a branded PDF quote.
 *
 *  - Page 1+: header + meta + customer/project + line items
 *  - Final page: totals + DOP conversion + terms
 *  - Footer on every page: site URL + page X / Y
 */

const PAGE_W = 612;       // 8.5"
const PAGE_H = 792;       // 11"
const MARGIN_L = 56;
const MARGIN_R = 56;
const MARGIN_T = 56;
const MARGIN_B = 56;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;

// Tuned to mirror the app's ink palette + brand accent
const INK       = rgb(0.09, 0.085, 0.07);   // ink-900
const INK_HIGH  = rgb(0.23, 0.22, 0.19);    // ink-800
const INK_MID   = rgb(0.42, 0.40, 0.36);    // ink-500
const INK_SOFT  = rgb(0.66, 0.64, 0.59);    // ink-400
const INK_LINE  = rgb(0.91, 0.90, 0.88);    // ink-100
const INK_LINE2 = rgb(0.82, 0.81, 0.78);    // ink-200
const BG_SOFT   = rgb(0.97, 0.965, 0.96);   // ink-50
const ACCENT    = rgb(0.78, 0.42, 0.16);    // brand-500
const WHITE     = rgb(1, 1, 1);

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

  // Line items table
  cursor = drawLineHeader(page, ctx, cursor);

  if (!lines.length) {
    cursor = drawEmptyLineBody(page, ctx, cursor);
  } else {
    for (const line of lines) {
      const needed = await measureLineRow(ctx, line);
      if (cursor.y - needed < MARGIN_B + 80) {
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

/* ------------------------------------------------------------------ */
/*  Header / meta / customer                                            */
/* ------------------------------------------------------------------ */

function drawHeader(page, ctx, logoImage) {
  const { fontBold, fontRegular, settings } = ctx;
  const top = PAGE_H - MARGIN_T;

  // Left side: logo OR companyName (never both — the logo usually IS the
  // wordmark). Address/contact go beneath in muted small caps.
  let leftBottomY = top;
  if (logoImage) {
    const maxH = 36;
    const maxW = 160;
    const scale = Math.min(maxH / logoImage.height, maxW / logoImage.width);
    const w = logoImage.width * scale;
    const h = logoImage.height * scale;
    page.drawImage(logoImage, { x: MARGIN_L, y: top - h, width: w, height: h });
    leftBottomY = top - h - 10;
  } else {
    page.drawText(settings.companyName || 'Your Company', {
      x: MARGIN_L, y: top - 18, size: 18, font: fontBold, color: INK,
    });
    leftBottomY = top - 28;
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
  const labelSize = 9;
  const labelW = fontRegular.widthOfTextAtSize(labelText, labelSize);
  page.drawText(labelText, {
    x: PAGE_W - MARGIN_R - labelW,
    y: top - labelSize,
    size: labelSize,
    font: fontRegular,
    color: INK_MID,
    characterSpacing: 1.2,
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

function drawQuoteMeta(page, ctx, cursor) {
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

  // Soft band
  const bandH = 44;
  page.drawRectangle({
    x: MARGIN_L, y: cursor.y - bandH + 8,
    width: CONTENT_W, height: bandH,
    color: BG_SOFT,
    borderColor: INK_LINE, borderWidth: 0.5,
  });

  const colW = CONTENT_W / cols.length;
  cols.forEach(([label, value], i) => {
    const x = MARGIN_L + 14 + i * colW;
    page.drawText(label, { x, y: cursor.y - 6, size: 7.5, font: fontRegular, color: INK_MID, characterSpacing: 0.8 });
    page.drawText(value, { x, y: cursor.y - 22, size: 11, font: fontBold, color: INK });
  });
  return { x: MARGIN_L, y: cursor.y - bandH - 14 };
}

function drawCustomerBlock(page, ctx, cursor) {
  const { fontBold, fontRegular, customer, quote } = ctx;
  const y0 = cursor.y;

  // Left column: customer
  page.drawText('PREPARADO PARA', { x: MARGIN_L, y: y0, size: 7.5, font: fontRegular, color: INK_MID, characterSpacing: 0.8 });
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
    page.drawText('PROYECTO', { x: MARGIN_L + CONTENT_W / 2, y: y0, size: 7.5, font: fontRegular, color: INK_MID, characterSpacing: 0.8 });
    page.drawText(truncate(quote.name, 38), {
      x: MARGIN_L + CONTENT_W / 2,
      y: y0 - 14, size: 12, font: fontBold, color: INK,
    });
  }

  const bottom = Math.min(y, y0 - 28);
  return { x: MARGIN_L, y: bottom - 18 };
}

function fontItalicOrRegular(ctx) {
  return ctx.fontItalic || ctx.fontRegular;
}

/* ------------------------------------------------------------------ */
/*  Line items                                                          */
/* ------------------------------------------------------------------ */

// All x positions absolute; right-aligned columns specify their right edge.
// Header labels need real horizontal gaps between adjacent columns. The
// previous layout had MATLABEL ending ~5pt before CANT. began, so they
// rendered as one run ("TELA / COLORCANT."). We push qty further right and
// shorten the material label to "MATERIAL".
function lineColumns() {
  const right = PAGE_W - MARGIN_R;
  return {
    img:  { x: MARGIN_L + 8,  size: 48 },
    item: { x: MARGIN_L + 68, w: 200 },
    mat:  { x: MARGIN_L + 280 },
    qty:  { rightX: right - 165, label: 'CANT.' },
    unit: { rightX: right - 80,  label: 'UNIT.' },
    tot:  { rightX: right - 8,   label: 'TOTAL' },
    itemLabel: 'ARTÍCULO',
    matLabel: 'MATERIAL',
  };
}

function drawLineHeader(page, ctx, cursor) {
  const { fontBold } = ctx;
  const cols = lineColumns();
  const headerH = 22;
  const y = cursor.y;
  // Dark band
  page.drawRectangle({
    x: MARGIN_L, y: y - headerH,
    width: CONTENT_W, height: headerH,
    color: INK,
  });
  const ty = y - 14;
  const labelSize = 7.5;
  const labelColor = rgb(0.93, 0.92, 0.90);
  page.drawText(cols.itemLabel, { x: cols.item.x, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
  page.drawText(cols.matLabel, { x: cols.mat.x, y: ty, size: labelSize, font: fontBold, color: labelColor, characterSpacing: 0.6 });
  drawRightAt(page, cols.qty.label, cols.qty.rightX, ty, labelSize, fontBold, labelColor);
  drawRightAt(page, cols.unit.label, cols.unit.rightX, ty, labelSize, fontBold, labelColor);
  drawRightAt(page, cols.tot.label, cols.tot.rightX, ty, labelSize, fontBold, labelColor);
  return { x: MARGIN_L, y: y - headerH - 6 };
}

async function measureLineRow() {
  return 64;
}

// Centered "Sin artículos" placeholder so the totals block doesn't appear to
// float over empty white space when the quote has no line items yet.
function drawEmptyLineBody(page, ctx, cursor) {
  const { fontRegular, fontItalic } = ctx;
  const boxH = 56;
  const top = cursor.y;
  const bottom = top - boxH;
  // Hairline under the dark header band so the empty area reads as a row.
  page.drawLine({
    start: { x: MARGIN_L, y: bottom },
    end:   { x: PAGE_W - MARGIN_R, y: bottom },
    thickness: 0.5,
    color: INK_LINE,
  });
  const msg = 'Sin artículos en esta cotización';
  const size = 9.5;
  const w = fontRegular.widthOfTextAtSize(msg, size);
  page.drawText(msg, {
    x: MARGIN_L + (CONTENT_W - w) / 2,
    y: top - (boxH / 2) - 3,
    size,
    font: fontItalic || fontRegular,
    color: INK_SOFT,
  });
  return { x: MARGIN_L, y: bottom };
}

async function drawLineRow(page, ctx, cursor, line) {
  const { doc, fontRegular, fontBold } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const rowH = 60;
  const innerTop = rowY - 12;

  // Image: variant > hero > vector
  const imgId = line.variant?.imageId || line.product?.heroImageId || line.product?.vectorImageId;
  const img = await embedImageById(doc, imgId);
  const box = cols.img.size;
  const boxY = rowY - rowH + 6;
  page.drawRectangle({
    x: cols.img.x, y: boxY, width: box, height: box,
    color: BG_SOFT, borderColor: INK_LINE, borderWidth: 0.5,
  });
  if (img) {
    const scale = Math.min(box / img.width, box / img.height) * 0.92;
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: cols.img.x + (box - w) / 2,
      y: boxY + (box - h) / 2,
      width: w, height: h,
    });
  }

  // Item: name (bold) / variant (mid) / reference (small mono-ish)
  let y = innerTop;
  page.drawText(truncate(line.product?.name || '(producto)', 34), { x: cols.item.x, y, size: 10.5, font: fontBold, color: INK });
  y -= 13;
  if (line.variant?.name) {
    page.drawText(truncate(line.variant.name, 38), { x: cols.item.x, y, size: 9, font: fontRegular, color: INK_HIGH });
    y -= 11;
  }
  if (line.variant?.reference) {
    page.drawText(line.variant.reference, { x: cols.item.x, y, size: 7.5, font: fontRegular, color: INK_SOFT });
    y -= 10;
  }
  if (line.notes) {
    page.drawText(truncate('Nota: ' + line.notes, 52), { x: cols.item.x, y, size: 7.5, font: ctx.fontItalic, color: INK_MID });
  }

  // Material / color (swatch + text)
  const matX = cols.mat.x;
  const swatch = await embedImageById(doc, line.swatchImageId || line.color?.swatchImageId);
  const swatchBox = 26;
  if (swatch) {
    const scale = Math.min(swatchBox / swatch.width, swatchBox / swatch.height);
    const w = swatch.width * scale;
    const h = swatch.height * scale;
    page.drawRectangle({
      x: matX, y: rowY - 28, width: swatchBox, height: swatchBox,
      color: BG_SOFT, borderColor: INK_LINE, borderWidth: 0.5,
    });
    page.drawImage(swatch, {
      x: matX + (swatchBox - w) / 2,
      y: rowY - 28 + (swatchBox - h) / 2,
      width: w, height: h,
    });
    const tx = matX + swatchBox + 8;
    page.drawText(truncate(line.material?.name || '—', 18), { x: tx, y: innerTop, size: 9.5, font: fontBold, color: INK });
    page.drawText(truncate(line.color?.name || '—', 18), { x: tx, y: innerTop - 11, size: 8.5, font: fontRegular, color: INK_MID });
    if (line.material?.grade) {
      page.drawText(`Grade ${line.material.grade}`, { x: tx, y: innerTop - 22, size: 7.5, font: fontRegular, color: INK_SOFT });
    }
  } else {
    page.drawText(truncate(line.material?.name || 'C.O.M.', 22), { x: matX, y: innerTop, size: 9.5, font: fontBold, color: INK });
    if (line.color?.name) {
      page.drawText(truncate(line.color.name, 22), { x: matX, y: innerTop - 11, size: 8.5, font: fontRegular, color: INK_MID });
    }
    if (line.material?.grade) {
      page.drawText(`Grade ${line.material.grade}`, { x: matX, y: innerTop - 22, size: 7.5, font: fontRegular, color: INK_SOFT });
    }
  }

  // Qty / Unit / Total — vertically centered in the row
  const numY = rowY - 26;
  const unit = applyLineAdjustments(line.basePrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);
  drawRightAt(page, String(line.qty || 0), cols.qty.rightX, numY, 10, fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(unit, ctx.currency, ctx.rates), cols.unit.rightX, numY, 10, fontRegular, INK_HIGH);
  drawRightAt(page, formatMoney(total, ctx.currency, ctx.rates), cols.tot.rightX, numY, 10.5, fontBold, INK);

  // Hairline separator
  page.drawLine({
    start: { x: MARGIN_L, y: rowY - rowH },
    end: { x: PAGE_W - MARGIN_R, y: rowY - rowH },
    thickness: 0.5,
    color: INK_LINE,
  });

  return { x: MARGIN_L, y: rowY - rowH };
}

/* ------------------------------------------------------------------ */
/*  Totals / DOP / terms                                                */
/* ------------------------------------------------------------------ */

function estimateTotalsHeight(quote) {
  let h = 18; // gap above
  h += 12 * 5; // up to 5 rows
  h += 14;     // total row
  h += 36;     // DOP strip
  if (quote.terms) h += 90;
  return h;
}

function drawTotals(page, ctx, cursor, totals) {
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

  // Subtotals
  for (const [label, value] of rows) {
    page.drawText(label, { x: leftX, y, size: 9.5, font: fontRegular, color: INK_MID });
    drawRightAt(page, formatMoney(value, ctx.currency, ctx.rates), rightX, y, 9.5, fontRegular, INK_HIGH);
    y -= 14;
  }

  // Divider above the grand total
  y -= 2;
  page.drawLine({
    start: { x: leftX, y: y + 8 },
    end: { x: rightX, y: y + 8 },
    thickness: 0.7, color: INK,
  });

  // Grand total
  page.drawText('Total', { x: leftX, y, size: 13, font: fontBold, color: INK });
  drawRightAt(page, formatMoney(totals.grandTotal, ctx.currency, ctx.rates), rightX, y, 14, fontBold, INK);
  y -= 22;

  // DOP conversion: rate on top line, RD$ amount on its own line below.
  const dopRate = effectiveDopRate(ctx.settings);
  const dopTotal = totals.grandTotal * dopRate;
  const rateLabel = rateSourceLabel(ctx.settings);
  const stripH = 38;
  page.drawRectangle({
    x: leftX, y: y - stripH + 6,
    width: panelW, height: stripH,
    color: BG_SOFT,
    borderColor: INK_LINE, borderWidth: 0.5,
  });
  page.drawText(`Tipo de cambio: 1 USD = ${dopRate.toFixed(2)} DOP`, {
    x: leftX + 10, y: y - 6, size: 8, font: fontRegular, color: INK_MID,
  });
  page.drawText(`(${rateLabel})`, {
    x: leftX + 10, y: y - 16, size: 7.5, font: fontRegular, color: INK_SOFT,
  });
  page.drawText('Total RD$', { x: leftX + 10, y: y - 28, size: 9, font: fontBold, color: INK });
  drawRightAt(page, `RD$ ${formatPlain(dopTotal)}`, rightX - 10, y - 28, 11, fontBold, INK);
  y -= stripH + 12;

  return { x: MARGIN_L, y };
}

function drawTerms(page, ctx, cursor) {
  const { fontRegular, fontBold, quote } = ctx;
  let y = cursor.y - 4;
  page.drawText('TÉRMINOS Y CONDICIONES', { x: MARGIN_L, y, size: 7.5, font: fontBold, color: INK_MID, characterSpacing: 0.8 });
  y -= 14;
  const lines = wrapText(quote.terms || '', 95);
  for (const ln of lines) {
    page.drawText(ln, { x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_HIGH });
    y -= 12;
  }
  return { x: MARGIN_L, y: y - 6 };
}

function drawFooter(page, ctx, pageNum, pageCount) {
  const { fontRegular, settings } = ctx;
  const y = 28;
  // Hairline
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

/* ------------------------------------------------------------------ */
/*  Utilities                                                           */
/* ------------------------------------------------------------------ */

function drawRightAt(page, text, rightX, y, size, font, color) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - w, y, size, font, color: color || INK });
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function wrapText(text, perLine) {
  const words = (text || '').split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine) {
      out.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

function validUntil(quote) {
  const created = quote.createdAt || Date.now();
  return new Date(created + 30 * 86400 * 1000).toLocaleDateString('es-DO');
}

function formatMoney(value, code, rates) {
  if (value == null || Number.isNaN(value)) return '—';
  const rate = rates?.[code] ?? 1;
  const v = value * rate;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${code}`;
  }
}

function formatPlain(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(value));
}

async function embedImageById(doc, id) {
  if (!id) return null;
  const res = await downloadImageBytes(id);
  if (!res?.bytes) return null;
  const u8 = res.bytes;
  const ct = (res.contentType || '').toLowerCase();
  try {
    if (ct.includes('png')) return await doc.embedPng(u8);
    if (ct.includes('jpeg') || ct.includes('jpg')) return await doc.embedJpg(u8);
    try { return await doc.embedPng(u8); } catch {}
    try { return await doc.embedJpg(u8); } catch {}
    return null;
  } catch {
    return null;
  }
}

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
