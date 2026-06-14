/**
 * Tests for the COMPANY (house) account cost discount — the dealer's own
 * account (settings.storeCustomerId) whose quotes are internal store-stock
 * orders read at dealer cost.
 *
 * Pins the money invariant: the discount gates on "this quote IS the company
 * account", scales EVERY product price uniformly (line + components, including
 * ranges), is clamped 0–100, never mutates its input, and flows through
 * quoteTotals only when settings is supplied — so commissions/accounting (which
 * omit settings) and regular-customer quotes are never discounted.
 *
 * Run with `npm test` (node:test + node:assert, via tsx).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  companyAccountId,
  isCompanyAccountQuote,
  companyDiscountPctFor,
  applyCompanyDiscount,
  computeTotals,
  lineForTotals,
} from '../src/lib/pricing.js';
import { quoteTotals } from '../src/core/quote/totals.js';
import { resolveLineItem } from '../src/core/quote/views/lineItem.js';

const SETTINGS = { storeCustomerId: 'acct-1', companyDiscountPct: 60 };
const COMPANY_QUOTE = { id: 'q1', customerId: 'acct-1' };
const CLIENT_QUOTE = { id: 'q2', customerId: 'someone-else' };

test('companyAccountId reads storeCustomerId (null when unset)', () => {
  assert.equal(companyAccountId(SETTINGS), 'acct-1');
  assert.equal(companyAccountId({}), null);
  assert.equal(companyAccountId(null), null);
});

test('isCompanyAccountQuote matches only the configured account', () => {
  assert.equal(isCompanyAccountQuote(COMPANY_QUOTE, SETTINGS), true);
  assert.equal(isCompanyAccountQuote(CLIENT_QUOTE, SETTINGS), false);
  // No account configured ⇒ never a company quote, even with a null customer.
  assert.equal(isCompanyAccountQuote({ customerId: null }, { companyDiscountPct: 60 }), false);
});

test('companyDiscountPctFor gates + clamps', () => {
  assert.equal(companyDiscountPctFor(COMPANY_QUOTE, SETTINGS), 60);
  assert.equal(companyDiscountPctFor(CLIENT_QUOTE, SETTINGS), 0);
  // Out-of-range pct is clamped to the legal 0–100 window.
  assert.equal(companyDiscountPctFor(COMPANY_QUOTE, { storeCustomerId: 'acct-1', companyDiscountPct: 150 }), 100);
  assert.equal(companyDiscountPctFor(COMPANY_QUOTE, { storeCustomerId: 'acct-1', companyDiscountPct: -5 }), 0);
  // Missing pct ⇒ 0 (graceful before the column/migration lands).
  assert.equal(companyDiscountPctFor(COMPANY_QUOTE, { storeCustomerId: 'acct-1' }), 0);
});

test('applyCompanyDiscount scales every base price by (1 − pct/100)', () => {
  const lines = [
    { id: 'l1', kind: 'item', qty: 2, unitPrice: 1000 },
    { id: 'l2', kind: 'item', qty: 1, priceMin: 500, priceMax: 800 },     // material-less range
    {
      id: 'l3', kind: 'item', qty: 1, unitPrice: 0,                        // compound
      components: [
        { id: 'c1', qty: 1, unitPrice: 300 },
        { id: 'c2', qty: 2, priceMin: 100, priceMax: 200 },
      ],
    },
  ];
  const out = applyCompanyDiscount(lines, 60); // factor 0.4
  assert.equal(out[0].unitPrice, 400);
  assert.equal(out[1].priceMin, 200);
  assert.equal(out[1].priceMax, 320);
  assert.equal(out[2].components[0].unitPrice, 120);
  assert.equal(out[2].components[1].priceMin, 40);
  assert.equal(out[2].components[1].priceMax, 80);
});

test('applyCompanyDiscount never mutates its input', () => {
  const line = { id: 'l1', kind: 'item', qty: 1, unitPrice: 1000, components: [{ id: 'c1', qty: 1, unitPrice: 300 }] };
  const before = structuredClone(line);
  const out = applyCompanyDiscount([line], 60);
  assert.deepEqual(line, before);            // original untouched
  assert.equal(out[0].unitPrice, 400);       // copy scaled
  assert.equal(out[0].components[0].unitPrice, 120);
});

test('applyCompanyDiscount with pct 0 returns the lines unchanged (a copy)', () => {
  const lines = [{ id: 'l1', kind: 'item', qty: 1, unitPrice: 1000 }];
  const out = applyCompanyDiscount(lines, 0);
  assert.notEqual(out, lines);               // fresh array
  assert.equal(out[0].unitPrice, 1000);
});

test('quoteTotals discounts a company quote ONLY when settings is supplied', () => {
  const lines = [{ id: 'l1', kind: 'item', qty: 1, unitPrice: 1000 }];
  // Baseline: list price, no settings.
  const list = quoteTotals(COMPANY_QUOTE, lines).grandTotal;
  // With settings → the same quote reads at 40% (60% off) of list, end to end.
  const cost = quoteTotals(COMPANY_QUOTE, lines, SETTINGS).grandTotal;
  assert.ok(Math.abs(cost - list * 0.4) < 1e-6, `expected ${list * 0.4}, got ${cost}`);
  // The figure equals computing the totals on the pre-scaled lines.
  const expected = computeTotals(applyCompanyDiscount(lines, 60).map(lineForTotals), COMPANY_QUOTE).grandTotal;
  assert.ok(Math.abs(cost - expected) < 1e-6);
});

test('quoteTotals never discounts a regular customer quote', () => {
  const lines = [{ id: 'l1', kind: 'item', qty: 1, unitPrice: 1000 }];
  const withSettings = quoteTotals(CLIENT_QUOTE, lines, SETTINGS).grandTotal;
  const without = quoteTotals(CLIENT_QUOTE, lines).grandTotal;
  assert.equal(withSettings, without);       // settings present, but not the company account
});

test('resolveLineItem scales the editor display to dealer cost (pct param)', () => {
  const line = { id: 'l1', kind: 'item', qty: 2, unitPrice: 1000 };
  // No pct → list price display (default behaviour unchanged).
  const list = resolveLineItem(line);
  assert.equal(list.unitNet, 1000);
  assert.equal(list.subtotal, 2000);
  assert.equal(list.companyDiscountPct, 0);
  // 60% → the displayed unit + subtotal read at cost, and the badge value is set.
  const cost = resolveLineItem(line, 60);
  assert.equal(cost.unitNet, 400);
  assert.equal(cost.subtotal, 800);
  assert.equal(cost.companyDiscountPct, 60);
  // The raw line the editor edits is NOT mutated (the unit-price input stays list).
  assert.equal(line.unitPrice, 1000);
});

test('resolveLineItem scales a compound + its components to cost', () => {
  const line = {
    id: 'l1', kind: 'item', qty: 1, unitPrice: 0,
    components: [
      { id: 'c1', qty: 1, unitPrice: 300 },
      { id: 'c2', qty: 2, unitPrice: 100 },
    ],
  };
  const cost = resolveLineItem(line, 60); // factor 0.4
  assert.equal(cost.subtotal, (300 + 200) * 0.4);          // compound rolls up at cost
  assert.equal(cost.components.find((c) => c.id === 'c1').total, 120);
  assert.equal(cost.components.find((c) => c.id === 'c2').total, 80);
  assert.equal(line.components[0].unitPrice, 300);          // raw components untouched
});
