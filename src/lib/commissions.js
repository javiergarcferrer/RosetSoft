/**
 * Commission math for outside professionals (architects, decorators) that
 * bring deals to the showroom and earn a cut of the resulting sale.
 *
 * The rule the dealer wants:
 *
 *   • Each professional has a *default* commission % (0–20). When you
 *     assign them to a quote, the quote inherits that %.
 *
 *   • The quote can override the default per-deal. Some professionals
 *     negotiate different cuts for different clients.
 *
 *   • The commission $ amount = quote total × (effective % / 100).
 *
 *   • Without a professional assigned, the quote earns no commission.
 *
 * The functions here are pure so they can be tested without Supabase.
 * The "quote total" comes from computeTotals() in pricing.js; this
 * module just multiplies.
 */

/** Hard cap the dealer set: no commission > 20% on a sale. */
export const COMMISSION_MAX_PCT = 20;

/**
 * Clamp a commission % into the legal range [0, 20]. Non-finite values
 * (NaN, string typos) collapse to 0 — the conservative direction, so a
 * typo earns the dealer money rather than overpaying the professional.
 */
export function clampCommissionPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > COMMISSION_MAX_PCT) return COMMISSION_MAX_PCT;
  return n;
}

/**
 * The effective % the quote earns, given the quote and the professional
 * record. Resolution order:
 *
 *   1. If the quote has its own commissionPct set (any number, including
 *      0), that wins. 0 is a legitimate "this deal earns nothing"
 *      override — the dealer can disable commission per-quote without
 *      removing the professional link.
 *
 *   2. Else fall back to the professional's defaultCommissionPct.
 *
 *   3. Else 0.
 *
 * Returns the clamped value so callers never have to worry about a
 * pre-clamp value sneaking through.
 */
export function effectiveCommissionPct(quote, professional) {
  if (quote?.commissionPct != null && quote.commissionPct !== '') {
    return clampCommissionPct(quote.commissionPct);
  }
  if (professional?.defaultCommissionPct != null) {
    return clampCommissionPct(professional.defaultCommissionPct);
  }
  return 0;
}

/**
 * Commission $ amount on a quote total. Caller passes the already-
 * computed grand total (post-margin, post-discount, post-tax,
 * post-shipping — i.e. the bottom line the customer pays) and the
 * effective %. Multiplication only, no rounding policy — the formatter
 * decides how to display.
 */
export function commissionAmount(total, pct) {
  const t = Number(total);
  if (!Number.isFinite(t)) return 0;
  return t * (clampCommissionPct(pct) / 100);
}
