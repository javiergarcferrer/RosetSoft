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
