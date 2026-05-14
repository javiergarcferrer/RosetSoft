import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { downloadImageBytes } from '../db/database.js';
import { applyLineAdjustments, ITBIS_PCT } from '../lib/pricing.js';
import { effectiveDopRate, rateSourceLabel } from '../lib/exchangeRate.js';

/**
 * Generates a branded PDF quote.
 *
 *  - Page 1+: header (logo, company info, quote meta) + line items table
 *  - Final page: totals + terms
 *  - Embeds product hero image, variant image, swatch image when available
 */

const PAGE_W = 612;       // 8.5"
const PAGE_H = 792;       // 11"
const MARGIN_L = 48;
const MARGIN_R = 48;
const MARGIN_T = 48;
const MARGIN_B = 48;

const INK = rgb(0.09, 0.085, 0.07);
const INK_MID = rgb(0.45, 0.43, 0.38);
const INK_LIGHT = rgb(0.85, 0.84, 0.82);
const ACCENT = rgb(0.78, 0.42, 0.16);
const BG_SOFT = rgb(0.97, 0.965, 0.96);

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
  let cursor = await drawHeader(page, ctx, logoImage);
  cursor = drawQuoteMeta(page, ctx, cursor);
  cursor = drawCustomerBlock(page, ctx, cursor);

  // Line items table
  cursor = drawLineHeaderRow(page, cursor);
  drawLineHeaderText(page, fontBold, cursor);

  for (const line of lines) {
    const needed = await measureLineRow(ctx, line);
    if (cursor.y - needed < MARGIN_B + 140) {
      drawFooter(page, ctx);
      page = doc.addPage([PAGE_W, PAGE_H]);
      cursor = { x: MARGIN_L, y: PAGE_H - MARGIN_T };
      cursor = drawLineHeaderRow(page, cursor);
      drawLineHeaderText(page, fontBold, cursor);
    }
    cursor = await drawLineRow(page, ctx, cursor, line);
  }

  // Totals block — make sure we have room (includes DOP conversion strip)
  const totalsHeight = 260 + (quote.terms ? 90 : 0);
  if (cursor.y - totalsHeight < MARGIN_B + 80) {
    drawFooter(page, ctx);
    page = doc.addPage([PAGE_W, PAGE_H]);
    cursor = { x: MARGIN_L, y: PAGE_H - MARGIN_T };
  }
  cursor = drawTotals(page, ctx, cursor, totals);
  if (quote.terms) cursor = drawTerms(page, ctx, cursor);
  drawFooter(page, ctx);

  // Page numbers
  const pageCount = doc.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    const p = doc.getPage(i);
    p.drawText(`${i + 1} / ${pageCount}`, {
      x: PAGE_W - MARGIN_R - 30,
      y: 22,
      size: 8,
      font: fontRegular,
      color: INK_MID,
    });
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

/* ------------------------------------------------------------------ */
/*  Drawing helpers                                                    */
/* ------------------------------------------------------------------ */

async function drawHeader(page, ctx, logoImage) {
  const { fontBold, fontRegular, settings } = ctx;
  let x = MARGIN_L;
  let y = PAGE_H - MARGIN_T;

  if (logoImage) {
    const targetH = 40;
    const scale = targetH / logoImage.height;
    const w = logoImage.width * scale;
    page.drawImage(logoImage, { x, y: y - targetH, width: w, height: targetH });
    x += w + 14;
  }

  page.drawText(settings.companyName || 'Your Company', {
    x, y: y - 12, size: 14, font: fontBold, color: INK,
  });
  const addressLines = [
    settings.companyAddress,
    [settings.companyPhone, settings.companyEmail].filter(Boolean).join(' · '),
  ].filter(Boolean);
  let ay = y - 26;
  for (const ln of addressLines) {
    page.drawText(ln, { x, y: ay, size: 8.5, font: fontRegular, color: INK_MID });
    ay -= 11;
  }

  // "COTIZACIÓN" label on the right
  const label = 'COTIZACIÓN';
  const labelW = fontBold.widthOfTextAtSize(label, 22);
  page.drawText(label, {
    x: PAGE_W - MARGIN_R - labelW,
    y: y - 14,
    size: 22,
    font: fontBold,
    color: INK,
  });
  page.drawRectangle({
    x: PAGE_W - MARGIN_R - labelW,
    y: y - 18,
    width: labelW,
    height: 2,
    color: ACCENT,
  });

  return { x: MARGIN_L, y: y - 70 };
}

function drawQuoteMeta(page, ctx, cursor) {
  const { fontBold, fontRegular, quote } = ctx;
  const labelSize = 8;
  const valueSize = 10;
  const cols = [
    ['NÚMERO', `#${quote.number || '—'}`],
    ['FECHA', new Date(quote.createdAt || Date.now()).toLocaleDateString('es-DO')],
    ['VÁLIDA HASTA', validUntil(quote)],
    ['ESTADO', (quote.status || 'borrador').toUpperCase()],
  ];
  let x = MARGIN_L;
  const colW = (PAGE_W - MARGIN_L - MARGIN_R) / cols.length;
  for (const [label, value] of cols) {
    page.drawText(label, { x, y: cursor.y, size: labelSize, font: fontRegular, color: INK_MID });
    page.drawText(value, { x, y: cursor.y - 14, size: valueSize, font: fontBold, color: INK });
    x += colW;
  }
  return { x: MARGIN_L, y: cursor.y - 38 };
}

function drawCustomerBlock(page, ctx, cursor) {
  const { fontBold, fontRegular, customer, quote } = ctx;
  page.drawText('PREPARADO PARA', { x: MARGIN_L, y: cursor.y, size: 8, font: fontRegular, color: INK_MID });
  let y = cursor.y - 14;
  if (customer) {
    page.drawText(customer.name || '—', { x: MARGIN_L, y, size: 11, font: fontBold, color: INK }); y -= 13;
    if (customer.company) { page.drawText(customer.company, { x: MARGIN_L, y, size: 9.5, font: fontRegular, color: INK }); y -= 11; }
    const addrLines = [customer.address, [customer.city, customer.state, customer.zip].filter(Boolean).join(', '), customer.country].filter(Boolean);
    for (const a of addrLines) { page.drawText(a, { x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_MID }); y -= 11; }
    const contact = [customer.email, customer.phone].filter(Boolean).join(' · ');
    if (contact) { page.drawText(contact, { x: MARGIN_L, y, size: 9, font: fontRegular, color: INK_MID }); y -= 11; }
  } else {
    page.drawText('(sin cliente asignado)', { x: MARGIN_L, y, size: 10, font: fontRegular, color: INK_MID });
    y -= 12;
  }

  // Quote name (project) right-aligned
  if (quote.name) {
    const t = quote.name;
    const w = fontBold.widthOfTextAtSize(t, 11);
    page.drawText('PROYECTO', {
      x: PAGE_W - MARGIN_R - Math.max(w, 60),
      y: cursor.y,
      size: 8, font: fontRegular, color: INK_MID,
    });
    page.drawText(t, {
      x: PAGE_W - MARGIN_R - w,
      y: cursor.y - 14,
      size: 11, font: fontBold, color: INK,
    });
  }

  return { x: MARGIN_L, y: y - 16 };
}

function drawLineHeaderRow(page, cursor) {
  const y = cursor.y;
  const w = PAGE_W - MARGIN_L - MARGIN_R;
  page.drawRectangle({ x: MARGIN_L, y: y - 18, width: w, height: 22, color: INK });
  return { x: MARGIN_L, y: y - 30 };
}

function drawLineHeaderText(page, font, cursor) {
  const cols = lineColumns();
  for (const col of cols) {
    if (!col.label) continue;
    const x = col.align === 'right'
      ? col.x + col.w - font.widthOfTextAtSize(col.label, 7.5)
      : col.x;
    page.drawText(col.label, { x, y: cursor.y + 13, size: 7.5, font, color: rgb(0.95, 0.95, 0.93) });
  }
}

function lineColumns() {
  return [
    { key: 'img',  x: MARGIN_L + 6,  w: 50,  label: '' },
    { key: 'item', x: MARGIN_L + 64, w: 200, label: 'ARTÍCULO' },
    { key: 'mat',  x: MARGIN_L + 270, w: 130, label: 'TELA / COLOR' },
    { key: 'qty',  x: PAGE_W - MARGIN_R - 165, w: 30, label: 'CANT.', align: 'right' },
    { key: 'unit', x: PAGE_W - MARGIN_R - 110, w: 60, label: 'UNIT.', align: 'right' },
    { key: 'tot',  x: PAGE_W - MARGIN_R - 6,  w: 50, label: 'TOTAL', align: 'right' },
  ];
}

async function measureLineRow(ctx, line) {
  // Rough estimate; actual layout is fixed-height with wrap for description.
  const desc = lineDescription(line);
  const lines = wrapText(desc, 30);
  return 56 + Math.max(0, lines.length - 1) * 9;
}

async function drawLineRow(page, ctx, cursor, line) {
  const { doc, fontRegular, fontBold } = ctx;
  const cols = lineColumns();
  const rowY = cursor.y;
  const rowH = 56;

  // Image (variant > product hero)
  const imgId = line.variant?.imageId || line.product?.heroImageId;
  const img = await embedImageById(doc, imgId);
  if (img) {
    const box = 44;
    const scale = Math.min(box / img.width, box / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawRectangle({ x: cols[0].x, y: rowY - rowH + 4, width: box, height: box, color: BG_SOFT });
    page.drawImage(img, {
      x: cols[0].x + (box - w) / 2,
      y: rowY - rowH + 4 + (box - h) / 2,
      width: w, height: h,
    });
  } else {
    page.drawRectangle({ x: cols[0].x, y: rowY - rowH + 4, width: 44, height: 44, color: BG_SOFT });
  }

  // Item name + variant + reference
  const itemX = cols[1].x;
  let y = rowY - 10;
  page.drawText(line.product?.name || '(product)', { x: itemX, y, size: 10, font: fontBold, color: INK });
  y -= 12;
  if (line.variant?.name) {
    page.drawText(truncate(line.variant.name, 38), { x: itemX, y, size: 8.5, font: fontRegular, color: INK_MID });
    y -= 10;
  }
  if (line.variant?.reference) {
    page.drawText(line.variant.reference, { x: itemX, y, size: 7.5, font: fontRegular, color: INK_MID });
    y -= 9;
  }
  if (line.notes) {
    page.drawText('Note: ' + truncate(line.notes, 50), { x: itemX, y, size: 7.5, font: ctx.fontItalic, color: INK_MID });
  }

  // Material / color (swatch + text)
  const matX = cols[2].x;
  const swatch = await embedImageById(doc, line.color?.swatchImageId);
  if (swatch) {
    const box = 22;
    const scale = Math.min(box / swatch.width, box / swatch.height);
    const w = swatch.width * scale;
    const h = swatch.height * scale;
    page.drawImage(swatch, {
      x: matX,
      y: rowY - 26 + (box - h) / 2,
      width: w, height: h,
    });
    page.drawText(line.material ? `${line.material.name}` : '—', { x: matX + 28, y: rowY - 12, size: 9, font: fontBold, color: INK });
    page.drawText(line.color ? truncate(line.color.name, 18) : '—', { x: matX + 28, y: rowY - 22, size: 8, font: fontRegular, color: INK_MID });
    if (line.material?.grade) {
      page.drawText(`Grade ${line.material.grade}`, { x: matX + 28, y: rowY - 32, size: 7.5, font: fontRegular, color: INK_MID });
    }
  } else {
    page.drawText(line.material ? line.material.name : 'C.O.M.', { x: matX, y: rowY - 12, size: 9, font: fontBold, color: INK });
    page.drawText(line.color?.name || '—', { x: matX, y: rowY - 22, size: 8, font: fontRegular, color: INK_MID });
    if (line.material?.grade) {
      page.drawText(`Grade ${line.material.grade}`, { x: matX, y: rowY - 32, size: 7.5, font: fontRegular, color: INK_MID });
    }
  }

  // Qty, Unit, Total
  const unit = applyLineAdjustments(line.basePrice, line.lineMarginPct, line.lineDiscountPct);
  const total = unit * (line.qty || 0);
  drawRight(page, String(line.qty || 0), cols[3].x + cols[3].w, rowY - 14, 9.5, fontRegular);
  drawRight(page, formatMoney(unit, ctx.currency, ctx.rates), cols[4].x + cols[4].w, rowY - 14, 9.5, fontRegular);
  drawRight(page, formatMoney(total, ctx.currency, ctx.rates), cols[5].x + cols[5].w, rowY - 14, 10, fontBold);

  // Line separator
  page.drawLine({
    start: { x: MARGIN_L, y: rowY - rowH + 2 },
    end: { x: PAGE_W - MARGIN_R, y: rowY - rowH + 2 },
    thickness: 0.5,
    color: INK_LIGHT,
  });

  return { x: MARGIN_L, y: rowY - rowH };
}

function drawTotals(page, ctx, cursor, totals) {
  const { fontBold, fontRegular, quote } = ctx;
  let y = cursor.y - 16;
  const rightX = PAGE_W - MARGIN_R;
  const leftX = PAGE_W - MARGIN_R - 240;

  const rows = [
    ['Subtotal', totals.subtotal, false],
  ];
  if (quote.marginPct) rows.push([`Margen (${quote.marginPct}%)`, totals.marginAmt, false]);
  if (quote.discountPct) rows.push([`Descuento (${quote.discountPct}%)`, -totals.discountAmt, false]);
  rows.push([`ITBIS (${ITBIS_PCT}%)`, totals.taxAmt, false]);
  if (quote.shipping) rows.push(['Envío', totals.shipping, false]);
  rows.push(['Total', totals.grandTotal, true]);

  for (const [label, value, bold] of rows) {
    page.drawText(label, { x: leftX, y, size: bold ? 11 : 9.5, font: bold ? fontBold : fontRegular, color: bold ? INK : INK_MID });
    drawRight(page, formatMoney(value, ctx.currency, ctx.rates), rightX, y, bold ? 11 : 9.5, bold ? fontBold : fontRegular);
    y -= bold ? 16 : 12;
  }
  page.drawLine({
    start: { x: leftX, y: y + 22 },
    end: { x: rightX, y: y + 22 },
    thickness: 0.7,
    color: INK,
  });

  // DOP conversion block — single line with rate + DOP-equivalent total
  const dopRate = effectiveDopRate(ctx.settings);
  const dopTotal = totals.grandTotal * dopRate;
  const rateLabel = rateSourceLabel(ctx.settings);
  y -= 4;
  page.drawRectangle({
    x: leftX - 6,
    y: y - 14,
    width: rightX - leftX + 12,
    height: 22,
    color: BG_SOFT,
  });
  const rateText = `Tipo de cambio: 1 USD = ${dopRate.toFixed(2)} DOP (${rateLabel})`;
  page.drawText(rateText, {
    x: leftX,
    y: y - 6,
    size: 8,
    font: fontRegular,
    color: INK_MID,
  });
  const dopText = `RD$ ${Math.round(dopTotal).toLocaleString('en-US')}`;
  drawRight(page, dopText, rightX, y - 6, 10.5, fontBold);
  y -= 24;

  return { x: MARGIN_L, y: y - 8 };
}

function drawTerms(page, ctx, cursor) {
  const { fontRegular, quote } = ctx;
  page.drawText('TÉRMINOS Y CONDICIONES', { x: MARGIN_L, y: cursor.y, size: 8, font: fontRegular, color: INK_MID });
  const lines = wrapText(quote.terms || '', 90);
  let y = cursor.y - 14;
  for (const ln of lines) {
    page.drawText(ln, { x: MARGIN_L, y, size: 8.5, font: fontRegular, color: INK });
    y -= 11;
  }
  return { x: MARGIN_L, y: y - 6 };
}

function drawFooter(page, ctx) {
  const { fontRegular, settings } = ctx;
  const text = settings.quoteFooter || `${settings.companyName || ''} · Prepared via Roset Soft`;
  if (!text) return;
  page.drawText(text, { x: MARGIN_L, y: 22, size: 7.5, font: fontRegular, color: INK_MID });
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

function drawRight(page, text, rightX, y, size, font) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - w, y, size, font, color: INK });
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

function lineDescription(line) {
  return [line.product?.name, line.variant?.name, line.notes].filter(Boolean).join(' — ');
}

function validUntil(quote) {
  const created = quote.createdAt || Date.now();
  return new Date(created + 30 * 86400 * 1000).toLocaleDateString();
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
