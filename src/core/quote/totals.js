// Model: per-quote money rollups shared by every list/detail ViewModel
// (the dashboard, the quotes & orders lists, the customer & professional
// detail pages). The ONE place the "keep priced lines → lineForTotals →
// computeTotals" dance lives, so every surface that sums a quote agrees to the
// cent — a compound quote rolls up its components, and the line-level + quote-
// level adjustments (discount, margin, ITBIS, shipping) always land.
//
// The builder, the client preview and the PDF do NOT go through here — they
// resolve the richer section/group tree via resolveQuoteView. This module is
// for the surfaces that only need a quote's bottom line.
import {
  computeTotals, lineForTotals, companyDiscountPctFor, applyCompanyDiscount,
  isCompanyAccountQuote, isCompoundLine, lineBasePrice, lineQty,
} from '../../lib/pricing.js';
import { isPricedLine } from '../../lib/constants.js';

// quoteId → its lines, from a flat quoteLines array fetched once. Lets a list
// page batch one query and roll up O(N+M) instead of N per-quote round-trips.
export function linesByQuoteId(lines) {
  const m = new Map();
  for (const l of lines || []) {
    if (!m.has(l.quoteId)) m.set(l.quoteId, []);
    m.get(l.quoteId).push(l);
  }
  return m;
}

// Canonical totals for one quote given its (unfiltered) lines.
//
// When `settings` is supplied AND the quote belongs to the COMPANY account
// (settings.storeCustomerId), every product price is scaled to dealer cost
// first (companyDiscountPct) so the dealer's surfaces read the order at cost.
// Callers that must NOT discount (commissions, accounting, the customer/pro
// rollups) simply omit `settings` — pct resolves to 0 and the lines pass
// through untouched, so the default behaviour is unchanged.
export function quoteTotals(quote, lines, settings) {
  const pct = companyDiscountPctFor(quote, settings);
  const eff = pct ? applyCompanyDiscount(lines, pct) : (lines || []);
  const rows = eff.filter(isPricedLine).map(lineForTotals);
  // A company-account quote is never taxed (internal order/cost doc), regardless
  // of whether THIS viewer sees cost (admin) or list (employee) — the discount
  // is role-gated upstream via `companyDiscountPct`, the exemption is not.
  return computeTotals(rows, quote, { taxExempt: isCompanyAccountQuote(quote, settings) });
}

// The single figure most list/detail rows show.
export const quoteGrandTotal = (quote, lines, settings) => quoteTotals(quote, lines, settings).grandTotal;

// Per-product margin roll-up — the dealer-cost view behind "calcular el margen
// con el margen asignado a cada producto". Each catalog line snapshots its
// wholesale `unitCost` when added (frozen, so a later price-list change never
// rewrites it), and the catalog's per-SKU margin IS (list − cost) / list — the
// "63%" the dealer reads in the Catálogo. This sums the LIST value vs the real
// catalog COST across a quote's priced lines and returns the resulting profit +
// blended margin %, so a surface can show the dealer what they make.
//
// Only lines that carry a real per-product cost contribute: a compound prices
// by components (which don't snapshot a cost) and a hand-typed line has none, so
// both are EXCLUDED from the figures and merely counted — the caller surfaces
// the coverage ("margen sobre N de M líneas") instead of quoting a margin that
// silently ignored half the order. `sell` is the catalog list (pre line-level
// adjustment) so the margin reflects the product, not a one-off discount. Pure.
export function quoteMargin(lines) {
  let sell = 0;
  let cost = 0;
  let linesPriced = 0;
  let linesWithCost = 0;
  for (const l of lines || []) {
    if (!isPricedLine(l)) continue;
    linesPriced += 1;
    const unitCost = Number(l?.unitCost);
    // A compound (no component-level cost) or a line with no/zero catalog cost
    // can't yield a per-product margin — count it, but keep it out of the math.
    if (isCompoundLine(l) || !Number.isFinite(unitCost) || unitCost <= 0) continue;
    const qty = lineQty(l);
    sell += lineBasePrice(l) * qty;   // catalog LIST value (unitPrice × qty)
    cost += unitCost * qty;           // real catalog COST
    linesWithCost += 1;
  }
  const profit = sell - cost;
  return {
    sell,
    cost,
    profit,
    marginPct: sell > 0 ? (profit / sell) * 100 : 0,
    linesPriced,
    linesWithCost,
  };
}
