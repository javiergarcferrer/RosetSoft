/**
 * Commission math for outside professionals (architects, interior
 * designers) that bring deals to the showroom and earn a cut of the sale.
 *
 * The rule the dealer wants:
 *
 *   • The sale's TYPE sets the rate: a floor order ("venta de piso") pays
 *     15%; a special order pays 20%. The quote carries an explicit
 *     `orderType` toggle ('floor' | 'special'), independent of whether the
 *     quote is attached to an order record. That tier IS the rate — there is
 *     no per-quote override.
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
 * When (if ever) the assigned professional's commission on a quote becomes
 * PAYABLE — i.e. the date the dealer actually owes the payout. Returns the
 * milestone timestamp that triggers it, or null if it isn't owed yet.
 *
 * The dealer's rule keys off the ORDER TYPE (the same toggle that sets the rate):
 *
 *   • Floor order ("venta de piso"): owed once the DEPOSIT is received
 *     (`depositReceivedAt`) — a floor sale collects on the deposit.
 *   • Special order: must be tied to an order/container (`orderId`) and is
 *     owed only once the BALANCE is paid (`balancePaidAt`). The deposit alone
 *     isn't enough — a special order rides on full collection when its
 *     container lands, so a special quote with no order can't owe yet.
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
        | 'orderType'
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
  if (quote.orderType === 'special') {
    // A special order settles on the BALANCE, collected only once the order is
    // in flight in a container — so it must be tied to an order and isn't owed
    // until that balance is paid.
    return quote.orderId ? (quote.balancePaidAt ?? null) : null;
  }
  // Floor order ("venta de piso"): owed once the DEPOSIT is received.
  return quote.depositReceivedAt ?? null;
}

/** True once the professional's commission on the quote has been paid out. */
export function isCommissionPaid(
  quote: Pick<Quote, 'commissionPaidAt'> | null | undefined,
): boolean {
  return quote?.commissionPaidAt != null;
}

/**
 * The commission $ to REPORT/DISPLAY for one stream of a quote: the amount
 * SNAPSHOTTED at payout time once paid — so a later order_type toggle, a
 * change to FLOOR/SPECIAL_COMMISSION_PCT, or an edit to a seller's rate can't
 * retroactively restate what was actually paid — otherwise the live-computed
 * amount. Pass the paid-at timestamp + frozen column for the stream
 * (professional: commissionPaidAt/commissionPaidAmount; seller:
 * sellerCommissionPaidAt/sellerCommissionPaidAmount).
 *
 * A non-finite stored value (legacy paid rows predating the snapshot column
 * carry null) falls through to the live amount, so old payouts still render.
 */
export function reportedCommission(
  paidAt: number | null | undefined,
  frozenAmount: number | null | undefined,
  liveAmount: number,
): number {
  if (paidAt != null && frozenAmount != null) {
    const n = Number(frozenAmount);
    if (Number.isFinite(n)) return n;
  }
  return liveAmount;
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
 * and BEFORE shipping), and the regular discount given to the client is funded
 * by the professional's cut, not the dealer's margin:
 *
 *   preDiscountBase = taxableBase + discountAmt + courtesyDiscountAmt  (base before any discount)
 *   gross           = preDiscountBase × pct/100    (full commission)
 *   net             = max(0, gross − discountAmt)  (only the regular discount comes out of it)
 *
 * The Friends & Family `courtesyDiscountAmt` is ADDED BACK into the commission
 * base and is NOT subtracted from the net: it's a courtesy the DEALER absorbs,
 * so the designer's payout is exactly what it would have been without it. Only
 * the commission-funded `discountAmt` reduces the net.
 *
 * Worked example — special order (20%), $1,000 base, 10% client discount:
 *   discountAmt = 100, taxableBase = 900, preDiscountBase = 1,000
 *   gross = 200, net = max(0, 200 − 100) = 100.
 * The dealer's net (900 − 100 = 800) matches a no-discount sale
 * (1,000 − 200 = 800): the discount fell entirely on the professional.
 *
 * Worked example — add a 5% Friends & Family courtesy on top of the above:
 *   courtesyDiscountAmt = 45 (5% of the 900 after the regular discount),
 *   taxableBase = 855, preDiscountBase = 855 + 100 + 45 = 1,000.
 *   gross = 200, net = max(0, 200 − 100) = 100 — UNCHANGED. The $45 courtesy
 *   came entirely out of the dealer's net, not the designer's commission.
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
  totals: Pick<Totals, 'taxableBase' | 'discountAmt' | 'courtesyDiscountAmt'> | null | undefined,
  pct: unknown,
): CommissionBreakdown {
  const taxable = Number(totals?.taxableBase);
  if (!Number.isFinite(taxable)) return { gross: 0, discount: 0, net: 0 };
  const rawDiscount = Number(totals?.discountAmt);
  const discount = Number.isFinite(rawDiscount) ? Math.max(0, rawDiscount) : 0;
  const rawCourtesy = Number(totals?.courtesyDiscountAmt);
  const courtesy = Number.isFinite(rawCourtesy) ? Math.max(0, rawCourtesy) : 0;
  // Add the courtesy back: the commission is computed on the base BEFORE both
  // discounts, but only the regular discount is drawn out of the net — the
  // dealer absorbs the Friends & Family courtesy.
  const preDiscountBase = taxable + discount + courtesy;
  const gross = preDiscountBase * (clampCommissionPct(pct) / 100);
  return { gross, discount, net: Math.max(0, gross - discount) };
}

/**
 * Full commission on the pre-discount base (preDiscountBase × pct/100),
 * BEFORE the client discount is drawn out. The figure the "Comisión (X%)"
 * line shows above the discount deduction.
 */
export function grossCommissionAmount(
  totals: Pick<Totals, 'taxableBase' | 'discountAmt' | 'courtesyDiscountAmt'> | null | undefined,
  pct: unknown,
): number {
  return commissionBreakdown(totals, pct).gross;
}

/** The NET commission the professional earns after the discount is drawn out. */
export function commissionAmount(
  totals: Pick<Totals, 'taxableBase' | 'discountAmt' | 'courtesyDiscountAmt'> | null | undefined,
  pct: unknown,
): number {
  return commissionBreakdown(totals, pct).net;
}
