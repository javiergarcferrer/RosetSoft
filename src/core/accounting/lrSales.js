// Ligne Roset sales report — the supplier sell-through ViewModel + its CSV /
// email builders. Pure: no React, no db, no I/O.
//
// What we report to Ligne Roset every month is our FLOOR sales ("ventas de
// piso") — accepted quotes NOT tied to an import order (a special/import order
// is excluded), recognized when the client deposit lands. This mirrors the
// `isFloorSale` rule in Facturación (a floor sale has no orderId). One row per
// product sold: each priced quote line, with a compound article rolling up to a
// single row at its line total. Amounts are USD — the currency of the Ligne
// Roset relationship.
import { QUOTE_STATUS_ACCEPTED, isPricedLine } from '../../lib/constants.js';
import { isCompoundLine, lineTotal, applyLineAdjustments } from '../../lib/pricing.js';
import { fabricDisplay } from '../../lib/subtype.js';
import { round2 } from '../../lib/accounting/ledger.js';

const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** Human month label in Spanish, e.g. "abril 2026". */
export function monthLabel(year, monthIndex) {
  return `${MONTHS_ES[monthIndex] || ''} ${year}`.trim();
}

/** [start, end] ms spanning the whole calendar month (inclusive, local time). */
export function monthRange(year, monthIndex) {
  const start = new Date(year, monthIndex, 1, 0, 0, 0, 0).getTime();
  const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999).getTime();
  return { start, end };
}

/**
 * The calendar month BEFORE `now` — the one you send on the 15th (sending in
 * May reports April). Date arithmetic normalizes monthIndex -1 → previous
 * December.
 */
export function previousMonth(now = Date.now()) {
  const d = new Date(now);
  const norm = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return { year: norm.getFullYear(), monthIndex: norm.getMonth() };
}

// Accepted, not tied to an order (floor), with its deposit received in window.
function isReportableFloorSale(q, start, end) {
  if (!q || q.status !== QUOTE_STATUS_ACCEPTED) return false;
  if (q.orderId) return false; // tied to an import order ⇒ special, not a floor sale
  const t = q.depositReceivedAt;
  return t != null && t >= start && t <= end;
}

/**
 * ONE row per product sold across every reportable floor sale in the window.
 *
 * @param quotes        all team quotes.
 * @param linesByQuote  Map<quoteId, QuoteLine[]> (see core/quote/totals:linesByQuoteId).
 * @param customersById Map<customerId, Customer>.
 * @param start, end    inclusive ms window (a calendar month).
 * @returns {{ rows: object[], totals: {qty, usd}, salesCount: number, lineCount: number }}
 */
export function resolveLrSales({ quotes, linesByQuote, customersById, start, end } = {}) {
  const custById = customersById || new Map();
  const byQuote = linesByQuote || new Map();
  const rows = [];
  const saleIds = new Set();

  for (const q of quotes || []) {
    if (!isReportableFloorSale(q, start, end)) continue;
    const customer = q.customerId ? custById.get(q.customerId) : null;
    const lines = (byQuote.get(q.id) || []).filter(isPricedLine);
    for (const line of lines) {
      const compound = isCompoundLine(line);
      const total = lineTotal(line);
      // A compound is one article (qty 1, priced at its rolled-up total); a
      // normal line keeps its qty and per-unit price after line adjustments.
      const qty = compound ? 1 : (Number(line.qty) || 0);
      const unit = compound
        ? total
        : applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
      rows.push({
        id: `${q.id}:${line.id}`,
        date: q.depositReceivedAt,
        quoteNumber: q.number ?? null,
        customer: customer?.name || '',
        reference: line.reference || '',
        product: line.name || line.family || '',
        fabric: compound ? '' : fabricDisplay(line.subtype),
        qty,
        unitUsd: round2(unit),
        totalUsd: round2(total),
      });
      saleIds.add(q.id);
    }
  }

  rows.sort((a, b) => (a.date || 0) - (b.date || 0) || (a.quoteNumber || 0) - (b.quoteNumber || 0));

  const totals = rows.reduce(
    (acc, r) => ({ qty: acc.qty + (Number(r.qty) || 0), usd: acc.usd + (Number(r.totalUsd) || 0) }),
    { qty: 0, usd: 0 },
  );
  totals.usd = round2(totals.usd);

  return { rows, totals, salesCount: saleIds.size, lineCount: rows.length };
}

function isoDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Header + data + total rows for downloadCsv (lib/csv). */
export function lrSalesCsv(report) {
  const head = [
    'Fecha', 'Cotización', 'Cliente', 'Referencia', 'Producto', 'Tela',
    'Cantidad', 'Precio unitario (USD)', 'Total (USD)',
  ];
  const body = (report?.rows || []).map((r) => [
    isoDate(r.date), r.quoteNumber ?? '', r.customer, r.reference, r.product,
    r.fabric, r.qty, r.unitUsd, r.totalUsd,
  ]);
  const footer = ['', '', '', '', '', 'Total', report?.totals?.qty ?? 0, '', report?.totals?.usd ?? 0];
  return [head, ...body, footer];
}

/**
 * Prefilled email to Ligne Roset — subject + body. The CSV rides as a MANUAL
 * attachment (a mailto: link can't carry one), so the body says it's attached.
 * Supplier-facing, so written in English.
 */
export function lrSalesEmail({ label, report, companyName } = {}) {
  const count = report?.lineCount || 0;
  const usd = report?.totals?.usd || 0;
  const usdStr = `US$ ${Number(usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const subject = `Sales report — ${label}`;
  const body = [
    'Hello,',
    '',
    `Please find attached our sales report for ${label} `
      + `(${count} item${count === 1 ? '' : 's'}, ${usdStr} total).`,
    '',
    'Best regards,',
    companyName || '',
  ].join('\n');
  return { subject, body };
}
