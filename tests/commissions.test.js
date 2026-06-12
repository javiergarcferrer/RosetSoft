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
  commissionAmount,
  grossCommissionAmount,
  commissionBreakdown,
  decoratorBilling,
  isTradeDiscount,
  commissionOwedAt,
  isCommissionPaid,
  reportedCommission,
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

/* ----------------------------- grossCommissionAmount ------------------ */

test('gross is the full commission on the PRE-discount base', () => {
  // Special order (20%), $1,000 pre-discount base, $100 client discount:
  // taxableBase = 900, discountAmt = 100, preDiscountBase = 1,000.
  // Gross is the full 200 (before the discount is drawn out); net is 100.
  assert.equal(grossCommissionAmount({ taxableBase: 900, discountAmt: 100 }, 20), 200);
  assert.equal(commissionAmount({ taxableBase: 900, discountAmt: 100 }, 20), 100);
});

test('with no discount gross equals net', () => {
  assert.equal(grossCommissionAmount({ taxableBase: 1000, discountAmt: 0 }, 10), 100);
  assert.equal(commissionAmount({ taxableBase: 1000, discountAmt: 0 }, 10), 100);
});

test('gross with a non-finite base is 0 (never NaN)', () => {
  assert.equal(grossCommissionAmount({ taxableBase: NaN, discountAmt: 0 }, 10), 0);
  assert.equal(grossCommissionAmount(null, 10), 0);
});

/* ----------------------------- commissionBreakdown -------------------- */

test('breakdown returns { gross, discount, net } and they reconcile', () => {
  // gross − discount = net is the equation the UI prints; it must hold so
  // the displayed "Base · % = gross − desc = net" can never be wrong.
  const b = commissionBreakdown({ taxableBase: 900, discountAmt: 100 }, 20);
  assert.deepEqual(b, { gross: 200, discount: 100, net: 100 });
  assert.equal(b.gross - b.discount, b.net);
});

test('breakdown floors net at 0 when the discount exceeds the gross', () => {
  // Floor order (15%), $1,000 pre-discount base, $200 discount:
  // gross 150, discount 200 → net max(0, −50) = 0. Discount term is the
  // full 200 even though the net floors (the dealer absorbs the excess).
  const b = commissionBreakdown({ taxableBase: 800, discountAmt: 200 }, 15);
  assert.deepEqual(b, { gross: 150, discount: 200, net: 0 });
});

test('breakdown with a non-finite base is all zeros', () => {
  assert.deepEqual(commissionBreakdown({ taxableBase: NaN }, 10), { gross: 0, discount: 0, net: 0 });
  assert.deepEqual(commissionBreakdown(null, 10), { gross: 0, discount: 0, net: 0 });
});

test('breakdown normalizes a negative/missing discount to 0', () => {
  assert.deepEqual(commissionBreakdown({ taxableBase: 1000, discountAmt: -50 }, 10), { gross: 100, discount: 0, net: 100 });
  assert.deepEqual(commissionBreakdown({ taxableBase: 1000 }, 10), { gross: 100, discount: 0, net: 100 });
});

test('breakdown: Friends & Family courtesy lowers the base, it is NOT drawn from the net', () => {
  // Special order (20%). $100 regular discount + a $45 courtesy bring the
  // taxableBase to 855. The courtesy is NOT added back / not drawn out — the
  // commission is the % on the post-courtesy base (855 + 100 = 955):
  //   gross = 20% × 955 = 191; net = 191 − 100 = 91.
  // The courtesy cost the designer only 20% × 45 = $9 (gross 200 → 191), not $45.
  const b = commissionBreakdown({ taxableBase: 855, discountAmt: 100 }, 20);
  assert.deepEqual(b, { gross: 191, discount: 100, net: 91 });
});

test('breakdown: courtesy alone is a proportional reduction, no dollar-for-dollar deduction', () => {
  // No regular discount, $50 courtesy → taxableBase 950, 20%: gross = net = 190.
  // The designer loses 20% × 50 = $10 vs a no-courtesy $1,000 base (gross 200).
  const b = commissionBreakdown({ taxableBase: 950, discountAmt: 0 }, 20);
  assert.deepEqual(b, { gross: 190, discount: 0, net: 190 });
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

test('floor order: the DEPOSIT activates the commission (orderType drives it)', () => {
  // Floor pays on the deposit; an unset orderType defaults to floor.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderType: 'floor', depositReceivedAt: DEP }),
    DEP,
  );
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, depositReceivedAt: DEP }),
    DEP,
  );
  // A floor order pays on its DEPOSIT even when tied to an order — the balance
  // doesn't gate a floor payout.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderType: 'floor', orderId: 'ord-1', depositReceivedAt: DEP, balancePaidAt: null }),
    DEP,
  );
  // No deposit yet → not owed.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderType: 'floor', depositReceivedAt: null }),
    null,
  );
});

test('special order: owed only once the BALANCE is paid, not the deposit', () => {
  // Deposit alone is NOT enough on a special order.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderType: 'special', orderId: 'ord-1', depositReceivedAt: DEP, balancePaidAt: null }),
    null,
  );
  // Balance paid → owed at the balance date.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderType: 'special', orderId: 'ord-1', depositReceivedAt: DEP, balancePaidAt: BAL }),
    BAL,
  );
});

test('special order must be tied to an order/container to ever owe', () => {
  // The balance is collected through the order's container; with no order
  // there's nothing to pay against, so a stray balancePaidAt still owes nothing.
  assert.equal(
    commissionOwedAt({ status: 'accepted', professionalId: PRO, orderType: 'special', orderId: null, balancePaidAt: BAL }),
    null,
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

/* ----------------------------- reportedCommission --------------------- */

test('reportedCommission: unpaid → the live amount (no freeze)', () => {
  // No paid-at timestamp → always live, even if a stray frozen value exists.
  assert.equal(reportedCommission(null, null, 150), 150);
  assert.equal(reportedCommission(null, 999, 150), 150);
  assert.equal(reportedCommission(undefined, undefined, 200), 200);
});

test('reportedCommission: paid → the frozen snapshot, not the live amount', () => {
  // Paid at some date with a snapshot of 180 — a later rate change moves the
  // live amount to 100, but the reported figure stays the 180 that was paid.
  assert.equal(reportedCommission(12345, 180, 100), 180);
  assert.equal(reportedCommission(12345, 0, 100), 0); // a real $0 payout is honored
});

test('reportedCommission: paid but no snapshot (legacy) → live amount', () => {
  // Rows paid before the snapshot column existed carry a null amount; they
  // fall back to the live figure rather than rendering blank.
  assert.equal(reportedCommission(12345, null, 120), 120);
  assert.equal(reportedCommission(12345, NaN, 120), 120);
});

test('reportedCommission: coerces a numeric-string snapshot (Postgres numeric)', () => {
  // Supabase can hand back a numeric column as a string; it must still
  // compare/format as a number.
  assert.equal(reportedCommission(12345, '180.50', 100), 180.5);
});

/* ── resolveSales + resolveCommissionsOverview (core/accounting/sales.js) ──
 * The cycle projection the Comisiones page and the accounting workspace
 * render: which accepted quotes count as sales in the window, the seller's
 * deposit-gated earned commission, the professional's owed/paid split, and
 * the company-wide overview roll-up the admin header shows. */
import { resolveSales, resolveCommissionsOverview } from '../src/core/accounting/sales.js';

const VS_CYCLE = { start: 1000, end: 2000 };
const VS_SELLER = { id: 'u1', name: 'Ana', commissionPct: 5 };
const VS_PRO = { id: 'p1', name: 'Deco SRL' };
// totalsFor stub: every quote books a $1,000 taxable base, no discount.
const vsTotalsFor = () => ({ taxableBase: 1000, discountAmt: 0, taxAmt: 180, grandTotal: 1180 });
const vsMaps = {
  customerById: new Map(),
  profileById: new Map([[VS_SELLER.id, VS_SELLER]]),
  professionalById: new Map([[VS_PRO.id, VS_PRO]]),
};

test('resolveSales: deposit-in-cycle earns the seller; accepted-only does not', () => {
  const quotes = [
    // Deposit landed in the window → seller earns 5% of 1,000 = 50, unpaid.
    { id: 'q1', status: 'accepted', acceptedAt: 1100, depositReceivedAt: 1200, createdByUserId: 'u1' },
    // Accepted in the window but no deposit yet → an entry, but no earned commission.
    { id: 'q2', status: 'accepted', acceptedAt: 1300, createdByUserId: 'u1' },
    // Outside the window entirely → not a sale of this cycle.
    { id: 'q3', status: 'accepted', acceptedAt: 5000, createdByUserId: 'u1' },
    // Not accepted → never a sale.
    { id: 'q4', status: 'draft', acceptedAt: 1100, createdByUserId: 'u1' },
  ];
  const r = resolveSales({ quotes, cycle: VS_CYCLE, totalsFor: vsTotalsFor, ...vsMaps });
  assert.equal(r.entries.length, 2);
  assert.equal(r.vendedorRows.length, 1);
  assert.equal(r.vendedorRows[0].commission, 50);
  assert.equal(r.vendedorRows[0].paid, 0);
  assert.equal(r.vendedorRows[0].pending, 50);
});

test('resolveCommissionsOverview: totals = seller + professional, paid + pending = commission', () => {
  const quotes = [
    // Seller commission earned (deposit in cycle) AND a floor-order pro
    // commission owed on the same deposit; the pro side already paid out $140.
    {
      id: 'q1', status: 'accepted', acceptedAt: 1100, depositReceivedAt: 1200,
      createdByUserId: 'u1', professionalId: 'p1', orderType: 'floor',
      commissionPaidAt: 1500, commissionPaidAmount: 140,
    },
    // Seller-only sale, seller already paid a frozen $40 snapshot.
    {
      id: 'q2', status: 'accepted', acceptedAt: 1300, depositReceivedAt: 1400,
      createdByUserId: 'u1', sellerCommissionPaidAt: 1600, sellerCommissionPaidAmount: 40,
    },
  ];
  const r = resolveSales({ quotes, cycle: VS_CYCLE, totalsFor: vsTotalsFor, ...vsMaps });
  const o = resolveCommissionsOverview(r);
  assert.equal(o.salesCount, 2);
  assert.equal(o.base, 2000);
  assert.equal(o.seller.commission, 90);          // 50 live + 40 frozen
  assert.equal(o.seller.paid, 40);
  assert.equal(o.seller.pending, 50);
  assert.equal(o.professional.commission, 140);   // frozen at payout (live would be 150)
  assert.equal(o.professional.paid, 140);
  assert.equal(o.professional.pending, 0);
  assert.equal(o.total.commission, o.seller.commission + o.professional.commission);
  assert.equal(o.total.paid + o.total.pending, o.total.commission);
});
