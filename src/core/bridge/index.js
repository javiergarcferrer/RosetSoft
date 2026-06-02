// The Bridge — the "pineal gland" / osmotic barrier between the two cores.
//
// The CRM core (core/quote: flexible, mutable sales data) and the Accounting
// core (core/accounting + lib/accounting: secured, data-integrity ledger) NEVER
// import each other. They meet ONLY here, through a small set of named,
// one-directional processes: CRM facts flow IN, accounting inputs flow OUT.
// Accounting never reaches back to mutate CRM — it only reads what crosses.
//
// Keeping every cross-core translation in this one module is what makes the
// boundary auditable: to see everything that passes between sales and the
// books, you read this file.
import { computeTotals, lineForTotals } from '../../lib/pricing.js';
import { isPricedLine } from '../../lib/constants.js';
import { round2 } from '../../lib/accounting/ledger.js';
import { saleEcfType } from '../../lib/accounting/ecf.js';

/**
 * PROCESS — Venta: a CRM quote (priced in USD) → the Accounting figures for its
 * sale, converted to DOP at `rate`. The accounting core consumes this shape
 * (sale posting + e-CF); it never sees the quote itself. Pure.
 *
 * @returns {{ quoteId, customerId, rate, usdTotal, base, itbis, total,
 *   deposit, ecfType, items }}
 */
export function quoteToSale({ quote, lines, rate, hasFiscalId }) {
  const r = Number(rate) || 0;
  const priced = (lines || []).filter(isPricedLine);
  const rows = priced.map(lineForTotals);
  const t = computeTotals(rows, quote);
  // Consolidated single line (the accounting sale books at the base); itemized
  // detail can be expanded later without changing the barrier's shape.
  const items = [{ name: `Venta #${quote?.number ?? ''}`.trim(), qty: 1, usd: t.taxableBase }];
  return {
    quoteId: quote?.id || null,
    customerId: quote?.customerId || null,
    rate: r,
    usdTotal: t.grandTotal,
    base: round2(t.taxableBase * r),
    itbis: round2(t.taxAmt * r),
    total: round2(t.grandTotal * r),
    deposit: round2((quote?.depositAmount || 0) * r),
    ecfType: saleEcfType(!!hasFiscalId),
    items,
  };
}

// PROCESS — Comisión: the seller/professional commission owed on a CRM sale is
// derived (not stored) by the accounting commission Model. It's a bridge
// concern by nature — a CRM event (the sale) producing an accounting payout —
// so it's surfaced here for both cores to consume.
export { resolveSales } from '../accounting/sales.js';
