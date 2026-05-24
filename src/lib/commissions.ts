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

import type { Quote, Professional, DecoratorBilling } from '../types/domain.ts';

/** Hard cap the dealer set: no commission > 20% on a sale. */
export const COMMISSION_MAX_PCT = 20;

/**
 * How the assigned professional's cut is realized. The SAME percentage
 * (the professional's rate) is used either way — only the accounting
 * direction differs:
 *
 *   • 'commission'     — invoice the client at full price and pay the
 *                        decorator their % as a commission.
 *   • 'trade_discount' — invoice the DECORATOR at their % off; pay no
 *                        commission (they already took their cut via the
 *                        discount).
 *
 * Internal/accounting only — the client PDF always shows the full price.
 * Anything not explicitly 'trade_discount' resolves to 'commission' (the
 * legacy default), so a missing/null field is safe.
 */
export function decoratorBilling(
  quote: Pick<Quote, 'decoratorBilling'> | null | undefined,
): DecoratorBilling {
  return quote?.decoratorBilling === 'trade_discount' ? 'trade_discount' : 'commission';
}

/** True when the quote settles the decorator via a trade discount. */
export function isTradeDiscount(
  quote: Pick<Quote, 'decoratorBilling'> | null | undefined,
): boolean {
  return decoratorBilling(quote) === 'trade_discount';
}

/**
 * Clamp a commission % into the legal range [0, 20]. Non-finite values
 * (NaN, string typos) collapse to 0 — the conservative direction, so a
 * typo earns the dealer money rather than overpaying the professional.
 */
export function clampCommissionPct(pct: unknown): number {
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
export function effectiveCommissionPct(
  quote: Pick<Quote, 'commissionPct'> | null | undefined,
  professional: Pick<Professional, 'defaultCommissionPct'> | null | undefined,
): number {
  if (quote?.commissionPct != null && (quote.commissionPct as unknown) !== '') {
    return clampCommissionPct(quote.commissionPct);
  }
  if (professional?.defaultCommissionPct != null) {
    return clampCommissionPct(professional.defaultCommissionPct);
  }
  return 0;
}

/**
 * Commission $ amount on a quote's *taxable base* (base imponible).
 *
 * The dealer's rule: commission is paid on the amount BEFORE ITBIS
 * and BEFORE shipping. computeTotals() in pricing.js exposes this as
 * `taxableBase` — that's the value callers should pass in here, not
 * `grandTotal`. Passing grandTotal over-pays the professional by
 * 18% (ITBIS) plus any shipping line.
 *
 * Multiplication only, no rounding policy — the formatter decides
 * how to display.
 */
export function commissionAmount(taxableBase: unknown, pct: unknown): number {
  const t = Number(taxableBase);
  if (!Number.isFinite(t)) return 0;
  return t * (clampCommissionPct(pct) / 100);
}
