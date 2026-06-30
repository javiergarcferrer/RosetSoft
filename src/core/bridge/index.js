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
import {
  computeTotals, lineForTotals, isCompoundLine, lineTotal, applyLineAdjustments, isCompanyAccountQuote,
} from '../../lib/pricing.js';
import { isPricedLine } from '../../lib/constants.js';
import { fabricDisplay } from '../../lib/subtype.js';
import { round2 } from '../../lib/accounting/ledger.js';
import { saleEcfType } from '../../lib/accounting/ecf.js';

/**
 * PROCESS — Venta: a CRM quote (priced in USD) → the Accounting figures for its
 * sale, converted to DOP at `rate`. The accounting core consumes this shape
 * (sale posting + e-CF); it never sees the quote itself. Pure.
 *
 * A company-account (house-stock) quote suppresses ITBIS, matching the on-screen
 * and PDF total — without it the books would charge 18% the quote showed as 0
 * (screen ≠ books). The bridge owns this CRM→books determination (it already
 * prices via lib/pricing); the caller just passes `settings`.
 *
 * The deposit is deliberately NOT carried across. A quote only SIGNALS that a
 * deposit was taken (its `deposito recibido` milestone); the money is recorded
 * — once — as a cobro in the books, which nets against this sale via the
 * receivables FIFO when it's invoiced. Letting the quote also inject a deposit
 * amount here would double-count it (the cobro already credited CxC), so the
 * sale books the FULL receivable and accounting stays the single source of
 * truth for the money. See core/accounting/deposits (the confirm queue).
 *
 * @returns {{ quoteId, customerId, rate, usdTotal, base, itbis, total,
 *   ecfType, items }}
 */
export function quoteToSale({ quote, lines, rate, hasFiscalId, settings = null }) {
  const r = Number(rate) || 0;
  const priced = (lines || []).filter(isPricedLine);
  const rows = priced.map(lineForTotals);
  const taxExempt = isCompanyAccountQuote(quote, settings);
  const t = computeTotals(rows, quote, { taxExempt });
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
    ecfType: saleEcfType(!!hasFiscalId),
    items,
  };
}

/**
 * PROCESS — Cobro de cuota: a payment-plan installment (CRM, priced in USD) →
 * the Accounting cobro input, converted to DOP at `rate`. When the quote is
 * already invoiced (`salesPostingId` given) the cobro is allocated to that
 * invoice; otherwise it's an unallocated ADVANCE the receivables FIFO applies
 * once the sale is invoiced (advances are allowed before invoicing). The shape
 * is exactly what `buildPaymentEntry` / the payments row consume — the books
 * never see the plan itself. Pure.
 *
 * @returns {{ direction, partyType, partyId, amount, method, reference, allocations }}
 */
export function planInstallmentToCobro({
  plan, installment, rate, method = 'bank', salesPostingId = null, reference = null,
}) {
  const r = Number(rate) || 0;
  const amount = round2(Number(installment?.amount || 0) * r);
  const ref = (reference
    || `Cuota ${installment?.n ?? ''}/${plan?.installmentCount ?? ''} · Plan ${plan?.number ?? ''}`
  ).replace(/\s+/g, ' ').trim();
  return {
    direction: 'in',
    partyType: 'customer',
    partyId: plan?.customerId || null,
    amount,
    method,
    reference: ref,
    allocations: salesPostingId && amount > 0 ? [{ docId: salesPostingId, amount }] : [],
  };
}

/**
 * PROCESS — Estado de factura: the accounting sale postings → the ONE fact the
 * CRM side may know about a quote's invoicing: that it was invoiced, under
 * which NCF, and where the e-CF stands. Read-only and one-directional (books →
 * sales); no amounts, no asiento — just the stamp. Latest posting per quote
 * wins. Pure.
 *
 * @returns {Map<string, { ncf: string, ecfStatus: string, postedAt: number }>}
 */
export function resolveQuoteInvoiceStatus(postings) {
  const m = new Map();
  for (const p of postings || []) {
    if (!p?.quoteId) continue;
    const prev = m.get(p.quoteId);
    if (!prev || (p.postedAt || 0) > prev.postedAt) {
      m.set(p.quoteId, { ncf: p.ncf || '', ecfStatus: p.ecfStatus || '', postedAt: p.postedAt || 0 });
    }
  }
  return m;
}

/**
 * PROCESS — Cuenta del cliente: the books' postings + cobros → the one money
 * summary a CRM surface may show about a customer's account: invoiced (net of
 * deposits applied), paid, and the open balance, in DOP. Same arithmetic the
 * receivables center uses (invoiced − paid); no aging, no docs — just the
 * stamp. One-directional, read-only. Pure.
 *
 * @returns {{ invoiced: number, paid: number, balance: number }}
 */
export function resolveCustomerAccount({ postings, payments, customerId }) {
  let invoiced = 0;
  for (const s of postings || []) {
    if (s.customerId !== customerId) continue;
    invoiced += (s.total || 0) - (s.depositApplied || 0);
  }
  let paid = 0;
  for (const p of payments || []) {
    if (p.direction === 'in' && p.partyType === 'customer' && p.partyId === customerId) {
      paid += p.amount || 0;
    }
  }
  return { invoiced: round2(invoiced), paid: round2(paid), balance: round2(invoiced - paid) };
}

/**
 * PROCESS — Ventas de piso: a CRM quote's priced lines → the per-product rows
 * the Ligne Roset sell-through report books, in USD. A compound article rolls
 * up to ONE row at its line total (qty 1); a normal line keeps its qty and
 * per-unit price after line adjustments. Pure — the accounting LR report VM
 * (core/accounting/lrSales:resolveLrSales) consumes these and never prices a
 * quote line itself.
 *
 * `lsgRefs` is the set of LifestyleGarden product references (SKUs); a row is
 * stamped `isLsg` when its line — or, for a compound, any priced component —
 * belongs to that brand. The Ligne Roset report drops those (they're not the
 * supplier's sell-through); other floor-sale surfaces can keep the label or
 * ignore it. With no set passed, nothing is flagged (back-compat).
 *
 * @returns {Array<{ lineId, reference, product, fabric, qty, unitUsd, totalUsd, isLsg }>}
 */
export function quoteFloorSaleRows({ lines, lsgRefs } = {}) {
  const lsg = lsgRefs instanceof Set ? lsgRefs : new Set(lsgRefs || []);
  const inLsg = (ref) => !!ref && lsg.has(ref);
  return (lines || []).filter(isPricedLine).map((line) => {
    const compound = isCompoundLine(line);
    const total = lineTotal(line);
    const qty = compound ? 1 : (Number(line.qty) || 0);
    const unit = compound
      ? total
      : applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
    const isLsg = inLsg(line.reference)
      || (compound && (line.components || []).some((c) => inLsg(c.reference)));
    return {
      lineId: line.id,
      reference: line.reference || '',
      product: line.name || line.family || '',
      fabric: compound ? '' : fabricDisplay(line.subtype),
      qty,
      unitUsd: round2(unit),
      totalUsd: round2(total),
      isLsg,
    };
  });
}

// PROCESS — Comisión: the seller/professional commission owed on a CRM sale is
// derived (not stored) by the accounting commission Model. It's a bridge
// concern by nature — a CRM event (the sale) producing an accounting payout —
// so it's surfaced here for both cores to consume.
export { resolveSales, resolveCommissionsOverview } from '../accounting/sales.js';
