/**
 * Commission math for outside professionals (architects, interior
 * designers) that bring deals to the showroom and earn a cut of the sale.
 *
 * The rule the dealer wants:
 *
 *   • The sale's TYPE sets the base rate: a floor order ("venta de piso")
 *     pays 15%; a special order pays 20%. The quote carries an explicit
 *     `orderType` toggle ('floor' | 'special'), independent of whether the
 *     quote is attached to an order record.
 *
 *   • A per-quote `commissionPct` can still override the base rate for a
 *     one-off deal (0 is a legitimate "earns nothing" override).
 *
 *   • Any DISCOUNT given to the client comes out of the professional's
 *     commission, not the dealer's margin: the client pays less and the
 *     professional earns less by the same amount, so the dealer's net is
 *     unchanged. See commissionAmount() for the arithmetic.
 *
 *   • Without a professional assigned, the quote earns no commission — and
 *     a discount simply lowers the client's price (the dealer absorbs it,
 *     since there's no commission to draw from).
 *
 * The functions here are pure so they can be tested without Supabase.
 * Totals (taxableBase, discountAmt) come from computeTotals() in pricing.ts.
 */

import type { Quote, DecoratorBilling, Totals } from '../types/domain.ts';

/** Hard cap the dealer set: no commission > 20% on a sale. */
export const COMMISSION_MAX_PCT = 20;

/**
 * Base commission rates by order type. A floor order ("venta de piso") pays
 * 15%; a special order pays 20%. The cap above equals the special rate, so a
 * special order with no discount sits exactly at the ceiling.
 */
export const FLOOR_COMMISSION_PCT = 15;
export const SPECIAL_COMMISSION_PCT = 20;

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
 * Base commission rate implied by the quote's order type: 15% for a floor
 * order, 20% for a special order. Defaults to floor (15%) when unset, so a
 * brand-new or legacy quote earns the floor rate.
 */
export function baseCommissionPct(
  quote: Pick<Quote, 'orderType'> | null | undefined,
): number {
  return quote?.orderType === 'special' ? SPECIAL_COMMISSION_PCT : FLOOR_COMMISSION_PCT;
}

/**
 * The effective % the quote earns. Resolution order:
 *
 *   1. An explicit per-quote `commissionPct` (any number, including 0)
 *      overrides — the dealer can fix or zero a single deal's rate without
 *      removing the professional link.
 *
 *   2. Else the base rate for the order type (floor 15% / special 20%).
 *
 * Returns the clamped value so callers never have to worry about a
 * pre-clamp value sneaking through.
 */
export function effectiveCommissionPct(
  quote: Pick<Quote, 'commissionPct' | 'orderType'> | null | undefined,
): number {
  if (quote?.commissionPct != null && (quote.commissionPct as unknown) !== '') {
    return clampCommissionPct(quote.commissionPct);
  }
  return clampCommissionPct(baseCommissionPct(quote));
}

/**
 * When (if ever) the assigned professional's commission on a quote becomes
 * PAYABLE — i.e. the date the dealer actually owes the payout. Returns the
 * milestone timestamp that triggers it, or null if it isn't owed yet.
 *
 * The dealer's rule for *when* a professional's cut is owed:
 *
 *   • Quote tied to an ORDER (`orderId` set): owed once the BALANCE is paid
 *     (`balancePaidAt`). On a special order the deposit alone isn't enough —
 *     the commission rides on full collection.
 *   • Standalone quote (no order — a "venta de piso", floor sale): owed once
 *     the DEPOSIT is received (`depositReceivedAt`).
 *
 * Only ACCEPTED quotes that have a professional and settle via the
 * 'commission' modality can owe a payout. 'trade_discount' quotes settle
 * the decorator through the invoice (billed at their % off), so there's no
 * commission to pay and this returns null.
 *
 * The returned timestamp also tells Contabilidad which cycle the payout
 * falls in (mirrors how seller commissions key off the deposit date).
 */
export function commissionOwedAt(
  quote:
    | Pick<
        Quote,
        | 'status'
        | 'professionalId'
        | 'orderId'
        | 'depositReceivedAt'
        | 'balancePaidAt'
        | 'decoratorBilling'
      >
    | null
    | undefined,
): number | null {
  if (!quote) return null;
  if (quote.status !== 'accepted') return null;   // mirrors QUOTE_STATUS_ACCEPTED
  if (!quote.professionalId) return null;
  if (isTradeDiscount(quote)) return null;
  const owed = quote.orderId ? quote.balancePaidAt : quote.depositReceivedAt;
  return owed ?? null;
}

/** True once the professional's commission on the quote has been paid out. */
export function isCommissionPaid(
  quote: Pick<Quote, 'commissionPaidAt'> | null | undefined,
): boolean {
  return quote?.commissionPaidAt != null;
}

/**
 * The assigned professional's commission decomposed into the three figures
 * every UI surface shows: the GROSS (full commission before the client
 * discount), the DISCOUNT drawn out of it, and the NET the professional
 * actually earns. This is the single source of truth for the commission
 * arithmetic — commissionAmount() returns the net, grossCommissionAmount()
 * the gross, and both the builder's CommissionCard and Contabilidad's
 * commission line render every term from here so the displayed equation
 * always reconciles (the bug it replaces: a detail string that multiplied
 * the post-discount base by the rate yet printed the net).
 *
 * The dealer's rule: commission is paid on the base imponible (BEFORE ITBIS
 * and BEFORE shipping), and any discount given to the client is funded by
 * the professional's cut, not the dealer's margin:
 *
 *   preDiscountBase = taxableBase + discountAmt   (base before the discount)
 *   gross           = preDiscountBase × pct/100    (full commission)
 *   net             = max(0, gross − discountAmt)  (discount comes out of it)
 *
 * Worked example — special order (20%), $1,000 base, 10% client discount:
 *   discountAmt = 100, taxableBase = 900, preDiscountBase = 1,000
 *   gross = 200, net = max(0, 200 − 100) = 100.
 * The dealer's net (900 − 100 = 800) matches a no-discount sale
 * (1,000 − 200 = 800): the discount fell entirely on the professional.
 *
 * If the discount exceeds the commission the net floors at 0 (the dealer
 * absorbs the excess). Pass the totals object from computeTotals(); a bare
 * number with no discount degrades gracefully via the nullish reads. A
 * non-finite base yields all-zeros rather than NaN.
 *
 * Multiplication only, no rounding policy — the formatter decides display.
 */
export interface CommissionBreakdown {
  /** Full commission before the client discount is drawn out. */
  gross: number;
  /** Client discount funded by the commission (>= 0). */
  discount: number;
  /** What the professional actually earns: max(0, gross − discount). */
  net: number;
}

export function commissionBreakdown(
  totals: Pick<Totals, 'taxableBase' | 'discountAmt'> | null | undefined,
  pct: unknown,
): CommissionBreakdown {
  const taxable = Number(totals?.taxableBase);
  if (!Number.isFinite(taxable)) return { gross: 0, discount: 0, net: 0 };
  const rawDiscount = Number(totals?.discountAmt);
  const discount = Number.isFinite(rawDiscount) ? Math.max(0, rawDiscount) : 0;
  const preDiscountBase = taxable + discount;
  const gross = preDiscountBase * (clampCommissionPct(pct) / 100);
  return { gross, discount, net: Math.max(0, gross - discount) };
}

/**
 * Full commission on the pre-discount base (preDiscountBase × pct/100),
 * BEFORE the client discount is drawn out. The figure the "Comisión (X%)"
 * line shows above the discount deduction.
 */
export function grossCommissionAmount(
  totals: Pick<Totals, 'taxableBase' | 'discountAmt'> | null | undefined,
  pct: unknown,
): number {
  return commissionBreakdown(totals, pct).gross;
}

/** The NET commission the professional earns after the discount is drawn out. */
export function commissionAmount(
  totals: Pick<Totals, 'taxableBase' | 'discountAmt'> | null | undefined,
  pct: unknown,
): number {
  return commissionBreakdown(totals, pct).net;
}
