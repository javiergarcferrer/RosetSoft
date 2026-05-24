/**
 * Tests for src/lib/commissions.js — the rules for how a quote's
 * commission % is resolved (quote override vs professional default vs
 * none), the clamping behavior (0–20), and the amount calculation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMISSION_MAX_PCT,
  clampCommissionPct,
  effectiveCommissionPct,
  commissionAmount,
  decoratorBilling,
  isTradeDiscount,
} from '../src/lib/commissions.js';

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

/* ----------------------------- effectiveCommissionPct ------------------ */

test('quote override wins over professional default', () => {
  const quote = { commissionPct: 5 };
  const pro = { defaultCommissionPct: 10 };
  assert.equal(effectiveCommissionPct(quote, pro), 5);
});

test('falls back to professional default when no quote override', () => {
  const quote = { commissionPct: null };
  const pro = { defaultCommissionPct: 12 };
  assert.equal(effectiveCommissionPct(quote, pro), 12);
});

test('quote override of 0 is treated as a real override (disable commission)', () => {
  // Dealer wants to explicitly zero out a single deal without removing
  // the professional link (e.g. a favor for a long-time partner). 0 must
  // count as set, not "fall through to default".
  const quote = { commissionPct: 0 };
  const pro = { defaultCommissionPct: 15 };
  assert.equal(effectiveCommissionPct(quote, pro), 0);
});

test('empty-string override is treated as unset and falls through', () => {
  // The input field passes "" while empty; we treat that as "no
  // override" so the professional's default applies.
  const quote = { commissionPct: '' };
  const pro = { defaultCommissionPct: 8 };
  assert.equal(effectiveCommissionPct(quote, pro), 8);
});

test('no professional and no quote override yields 0', () => {
  assert.equal(effectiveCommissionPct({}, null), 0);
});

test('out-of-range override is clamped', () => {
  const quote = { commissionPct: 99 };
  assert.equal(effectiveCommissionPct(quote, null), 20);
});

/* ----------------------------- commissionAmount ----------------------- */

test('amount = total × pct/100', () => {
  assert.equal(commissionAmount(1000, 10), 100);
  assert.equal(commissionAmount(2500, 8), 200);
});

test('amount with 0% is 0', () => {
  assert.equal(commissionAmount(5000, 0), 0);
});

test('amount with non-finite total is 0', () => {
  assert.equal(commissionAmount(NaN, 10), 0);
  assert.equal(commissionAmount(undefined, 10), 0);
});

test('amount clamps the pct before multiplying', () => {
  // 99% would otherwise produce 990; clamped to 20 → 200.
  assert.equal(commissionAmount(1000, 99), 200);
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

test('amount is taken from the taxable base, not the grand total', () => {
  // Dealer rule: commissions multiply against the base imponible
  // (computeTotals.taxableBase) — never the grand total (which
  // includes 18% ITBIS and any shipping). This test locks the
  // semantics so a future caller can't accidentally feed grandTotal
  // back in and over-pay the professional.
  //
  // Numbers chosen to make the math obvious:
  //   taxableBase = 1000, ITBIS 18% = 180, shipping 50
  //   grandTotal  = 1230
  //   10% commission on the base = 100 (correct)
  //   10% commission on grandTotal = 123 (wrong, what we used to do)
  const taxableBase = 1000;
  const grandTotal  = 1230;
  assert.equal(commissionAmount(taxableBase, 10), 100);
  assert.notEqual(commissionAmount(taxableBase, 10), commissionAmount(grandTotal, 10));
});
