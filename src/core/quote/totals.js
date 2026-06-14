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
  return computeTotals(rows, quote);
}

// The single figure most list/detail rows show.
export const quoteGrandTotal = (quote, lines, settings) => quoteTotals(quote, lines, settings).grandTotal;
