/**
 * Tests for src/lib/commissions.js — the rules for how a quote's commission
 * % is resolved (order-type base rate of 15%/20% vs a per-quote override),
 * the clamping behavior (0–20), and the discount-aware amount calculation
 * (the client discount is drawn out of the professional's commission).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMISSION_MAX_PCT,
  FLOOR_COMMISSION_PCT,
  SPECIAL_COMMISSION_PCT,
  clampCommissionPct,
  baseCommissionPct,
  effectiveCommissionPct,
  commissionAmount,
  decoratorBilling,
  isTradeDiscount,
  commissionOwedAt,
  isCommissionPaid,
} from '../src/lib/commissions.js';

test('the floor/special base rates are 15% and 20%', () => {
  assert.equal(FLOOR_COMMISSION_PCT, 15);
  assert.equal(SPECIAL_COMMISSION_PCT, 20);
});

test('the max commission is the 20% cap the dealer asked for', () => {
  assert.equal(COMMISSION_MAX_PCT, 20);
});

/* ----------------------------- clampCommissionPct ---------------------- */

test('clamps within range', () => {
  assert.equal(clampCommissionPct(0), 0);
  assert.equal(clampCommissionPct(10), 10);
  assert.equal(clampCommissionPct(20), 20);
});

test('clamps below 0 → 0 and above 20 → 20', () => {
  assert.equal(clampCommissionPct(-5), 0);
  assert.equal(clampCommissionPct(25), 20);
});

test('non-finite values collapse to 0 (dealer-favoring default)', () => {
  // The choice of 0 (not 20) for a NaN typo is deliberate: a typo
  // shouldn't accidentally promise more money to the professional.
  assert.equal(clampCommissionPct(NaN), 0);
  assert.equal(clampCommissionPct('not a number'), 0);
  assert.equal(clampCommissionPct(undefined), 0);
});

/* ----------------------------- baseCommissionPct ---------------------- */

test('base rate is 15% for a floor order, 20% for a special order', () => {
  assert.equal(baseCommissionPct({ orderType: 'floor' }), 15);
  assert.equal(baseCommissionPct({ orderType: 'special' }), 20);
});

test('base rate defaults to the floor rate (15%) when orderType is unset', () => {
  assert.equal(baseCommissionPct({}), 15);
  assert.equal(baseCommissionPct(null), 15);
  assert.equal(baseCommissionPct(undefined), 15);
});

/* ----------------------------- effectiveCommissionPct ------------------ */

test('floor order with no override earns the 15% base rate', () => {
  assert.equal(effectiveCommissionPct({ orderType: 'floor' }), 15);
});

test('special order with no override earns the 20% base rate', () => {
  assert.equal(effectiveCommissionPct({ orderType: 'special' }), 20);
});

test('a quote with no orderType defaults to the floor rate', () => {
  assert.equal(effectiveCommissionPct({}), 15);
});

test('an explicit commissionPct overrides the order-type base rate', () => {
  assert.equal(effectiveCommissionPct({ orderType: 'special', commissionPct: 12 }), 12);
});

test('override of 0 is treated as a real override (disable commission)', () => {
  // Zero out a single deal without changing its type or removing the
  // professional link — 0 must count as set, not "fall through to base".
  const quote = { orderType: 'special', commissionPct: 0 };
  assert.equal(effectiveCommissionPct(quote), 0);
});

test('empty-string override is treated as unset and falls through to base', () => {
  // The input field passes "" while empty; we treat that as "no override"
  // so the order-type base rate applies.
  assert.equal(effectiveCommissionPct({ orderType: 'special', commissionPct: '' }), 20);
  assert.equal(effectiveCommissionPct({ orderType: 'floor', commissionPct: null }), 15);
});

test('out-of-range override is clamped to the 20% cap', () => {
  assert.equal(effectiveCommissionPct({ commissionPct: 99 }), 20);
});

/* ----------------------------- commissionAmount ----------------------- */

test('with no discount, amount = base × pct/100', () => {
  assert.equal(commissionAmount({ taxableBase: 1000, discountAmt: 0 }, 10), 100);
  assert.equal(commissionAmount({ taxableBase: 2500, discountAmt: 0 }, 8), 200);
});

test('the client discount is drawn out of the commission', () => {
  // Special order (20%), $1,000 pre-discount base, $100 (10%) client
  // discount: taxableBase = 900, discountAmt = 100. Full commission on the
  // pre-discount base is 200; minus the 100 discount → 100 net. The dealer's
  // net (900 − 100) equals a no-discount sale (1000 − 200): discount-neutral.
  assert.equal(commissionAmount({ taxableBase: 900, discountAmt: 100 }, 20), 100);
});

test('a discount that exceeds the commission floors the payout at 0', () => {
  // Floor order (15%), $1,000 pre-discount base, $200 (20%) discount:
  // full commission 150, minus 200 → max(0, −50) = 0.
  assert.equal(commissionAmount({ taxableBase: 800, discountAmt: 200 }, 15), 0);
});

test('amount with 0% is 0', () => {
  assert.equal(commissionAmount({ taxableBase: 5000, discountAmt: 0 }, 0), 0);
});

test('amount with non-finite base is 0', () => {
  assert.equal(commissionAmount({ taxableBase: NaN, discountAmt: 0 }, 10), 0);
  assert.equal(commissionAmount(null, 10), 0);
  assert.equal(commissionAmount(undefined, 10), 0);
});

test('a missing discountAmt is treated as no discount', () => {
  assert.equal(commissionAmount({ taxableBase: 1000 }, 10), 100);
});

test('amount clamps the pct before multiplying', () => {
  // 99% would otherwise produce 990; clamped to 20 → 200.
  assert.equal(commissionAmount({ taxableBase: 1000, discountAmt: 0 }, 99), 200);
});

/* ----------------------------- decoratorBilling ----------------------- */

test('decoratorBilling defaults to commission when unset/null/missing', () => {
  // Every legacy quote (and any quote that hasn't picked a modality)
  // must resolve to the prior, only behavior: a commission.
  assert.equal(decoratorBilling(undefined), 'commission');
  assert.equal(decoratorBilling(null), 'commission');
  assert.equal(decoratorBilling({}), 'commission');
  assert.equal(decoratorBilling({ decoratorBilling: null }), 'commission');
  assert.equal(decoratorBilling({ decoratorBilling: 'commission' }), 'commission');
});

test('decoratorBilling recognizes the trade discount modality', () => {
  assert.equal(decoratorBilling({ decoratorBilling: 'trade_discount' }), 'trade_discount');
});

test('an unknown modality value falls back to commission (safe default)', () => {
  // A typo / future value must never silently behave as a trade discount,
  // which would mis-route the invoice to the decorator.
  assert.equal(decoratorBilling({ decoratorBilling: 'garbage' }), 'commission');
});

test('isTradeDiscount is true only for the trade_discount modality', () => {
  assert.equal(isTradeDiscount({ decoratorBilling: 'trade_discount' }), true);
  assert.equal(isTradeDiscount({ decoratorBilling: 'commission' }), false);
  assert.equal(isTradeDiscount({}), false);
  assert.equal(isTradeDiscount(null), false);
});

test('amount is computed on the taxable base, never the grand total', () => {
  // Dealer rule: commissions multiply against the base imponible
  // (computeTotals.taxableBase) — never the grand total (which includes
  // 18% ITBIS and any shipping). commissionAmount reads only taxableBase +
  // discountAmt off the totals object, so ITBIS/shipping can't leak in.
  //   taxableBase = 1000, no discount → 10% = 100 (correct)
  //   a grand-total-sized 1230 would over-pay → must differ
  const onBase = commissionAmount({ taxableBase: 1000, discountAmt: 0 }, 10);
  assert.equal(onBase, 100);
  assert.notEqual(onBase, commissionAmount({ taxableBase: 1230, discountAmt: 0 }, 10));
});

/* ----------------------------- commissionOwedAt ----------------------- */

const PRO = 'pro-1';
const DEP = 1000;   // deposit received timestamp
const BAL = 2000;   // balance paid timestamp

test('not owed until the quote is accepted', () => {
  assert.equal(commissionOwedAt({ status: 'sent', professionalId: PRO, depositReceivedAt: DEP }), null);
  assert.equal(commissionOwedAt({ status: 'draft', professionalId: PRO, depositReceivedAt: DEP }), null);
});

test('not owed without a professional assigned', () => {
  assert.equal(commissionOwedAt({ status: 'accepted', professionalId: null, depositReceivedAt: DEP }), null);
});

test('trade-discount quotes never owe a commission payout', () => {
  // The decorator already took their cut via the invoice discount.
  assert.equal(
    commissionOwedAt({
      status: 'accepted', professionalId: PRO, decoratorBilling: 'trade_discount',
      depositReceivedAt: DEP,
    }),
    null,
  );
});

test('floor sale (no order): the DEPOSIT activates the commission', () => {
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderId: null, depositReceivedAt: DEP }),
    DEP,
  );
  // No deposit yet → not owed.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderId: null, depositReceivedAt: null }),
    null,
  );
});

test('order-linked quote: owed only once the BALANCE is paid, not the deposit', () => {
  // Deposit alone is NOT enough on a special order.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderId: 'ord-1', depositReceivedAt: DEP, balancePaidAt: null }),
    null,
  );
  // Balance paid → owed at the balance date.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderId: 'ord-1', depositReceivedAt: DEP, balancePaidAt: BAL }),
    BAL,
  );
});

test('commissionOwedAt tolerates null/undefined', () => {
  assert.equal(commissionOwedAt(null), null);
  assert.equal(commissionOwedAt(undefined), null);
});

/* ----------------------------- isCommissionPaid ----------------------- */

test('isCommissionPaid reflects the commissionPaidAt timestamp', () => {
  assert.equal(isCommissionPaid({ commissionPaidAt: 12345 }), true);
  assert.equal(isCommissionPaid({ commissionPaidAt: null }), false);
  assert.equal(isCommissionPaid({}), false);
  assert.equal(isCommissionPaid(null), false);
});
