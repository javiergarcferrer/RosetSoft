/**
 * Tests for src/lib/pricing.js.
 *
 * Run with `npm test`. Pure ESM, no dependencies — uses Node's built-in test
 * runner (node:test, available since Node 18) plus node:assert.
 *
 * Coverage focus is the correctness contract documented on computeTotals:
 *   - Order of operations: margin → discount → tax → shipping
 *   - Input clamping: discount in [0, 100], shipping ≥ 0
 *   - Non-finite coercion to 0 (defense in depth)
 *   - Negative margin allowed (clearance)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ITBIS_PCT,
  clampPct,
  applyLineAdjustments,
  computeTotals,
  resolveLineBasePrice,
  variantPriceForGrade,
} from '../src/lib/pricing.js';

/* ----------------------------- clampPct ------------------------------- */

test('clampPct returns the value when in range', () => {
  assert.equal(clampPct(0), 0);
  assert.equal(clampPct(50), 50);
  assert.equal(clampPct(100), 100);
});

test('clampPct clamps negatives to 0', () => {
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(-Infinity), 0);
});

test('clampPct clamps above-max to the max', () => {
  assert.equal(clampPct(150), 100);
  assert.equal(clampPct(101), 100);
  assert.equal(clampPct(150, 200), 150);   // custom max
  assert.equal(clampPct(250, 200), 200);
});

test('clampPct coerces non-finite to 0', () => {
  assert.equal(clampPct(NaN), 0);
  assert.equal(clampPct(undefined), 0);
  assert.equal(clampPct(null), 0);
  assert.equal(clampPct('abc'), 0);
});

test('clampPct accepts numeric strings', () => {
  assert.equal(clampPct('25'), 25);
  assert.equal(clampPct('  10  '), 10);
});

/* ----------------------- applyLineAdjustments ------------------------- */

test('applyLineAdjustments: no adjustments returns base price', () => {
  assert.equal(applyLineAdjustments(100, 0, 0), 100);
});

test('applyLineAdjustments: positive margin lifts the price', () => {
  assert.equal(applyLineAdjustments(100, 20, 0), 120);
});

test('applyLineAdjustments: negative margin discounts below cost (clearance)', () => {
  // Negative margin is intentionally allowed — selling under cost for clearance
  // is a legitimate dealer action that should not silently round up to 0.
  assert.equal(applyLineAdjustments(100, -10, 0), 90);
});

test('applyLineAdjustments: discount eats the margined total', () => {
  // 100 → margin +20% → 120 → discount 10% → 108
  assert.equal(applyLineAdjustments(100, 20, 10), 108);
});

test('applyLineAdjustments: negative discount is clamped to 0', () => {
  assert.equal(applyLineAdjustments(100, 0, -10), 100);
});

test('applyLineAdjustments: discount > 100% clamps to 100%', () => {
  assert.equal(applyLineAdjustments(100, 0, 150), 0);
});

test('applyLineAdjustments: 100% discount yields 0', () => {
  assert.equal(applyLineAdjustments(100, 0, 100), 0);
});

test('applyLineAdjustments: non-finite base price coerces to 0', () => {
  assert.equal(applyLineAdjustments(NaN, 20, 10), 0);
  assert.equal(applyLineAdjustments(undefined, 20, 10), 0);
  assert.equal(applyLineAdjustments(null, 20, 10), 0);
});

/* --------------------------- computeTotals ---------------------------- */

test('computeTotals: empty lines yields zero subtotal, ITBIS still applied (to 0)', () => {
  const t = computeTotals([], {});
  assert.equal(t.subtotal, 0);
  assert.equal(t.marginAmt, 0);
  assert.equal(t.discountAmt, 0);
  assert.equal(t.taxAmt, 0);
  assert.equal(t.shipping, 0);
  assert.equal(t.grandTotal, 0);
  assert.equal(t.taxPct, ITBIS_PCT);
});

test('computeTotals: single line, no quote-level adjustments', () => {
  // qty 2, basePrice 100 → subtotal 200 → ITBIS 36 → total 236
  const t = computeTotals(
    [{ qty: 2, basePrice: 100, lineMarginPct: 0, lineDiscountPct: 0 }],
    {},
  );
  assert.equal(t.subtotal, 200);
  assert.equal(t.taxAmt, 36);
  assert.equal(t.grandTotal, 236);
});

test('computeTotals: order of ops is margin → discount → tax → shipping', () => {
  // 100 × 1 = 100 subtotal
  // margin 10% → 110 (afterMargin)
  // discount 10% → 99 (taxable base)
  // ITBIS 18% of 99 = 17.82
  // shipping 5 → grand total 99 + 17.82 + 5 = 121.82
  const t = computeTotals(
    [{ qty: 1, basePrice: 100, lineMarginPct: 0, lineDiscountPct: 0 }],
    { marginPct: 10, discountPct: 10, shipping: 5 },
  );
  assert.equal(t.subtotal, 100);
  assert.equal(t.marginAmt, 10);
  assert.equal(Math.round(t.discountAmt * 100) / 100, 11);   // 10% of 110
  assert.equal(Math.round(t.taxableBase * 100) / 100, 99);
  assert.equal(Math.round(t.taxAmt * 100) / 100, 17.82);
  assert.equal(t.shipping, 5);
  assert.equal(Math.round(t.grandTotal * 100) / 100, 121.82);
});

test('computeTotals: line-level adjustments compose with quote-level', () => {
  // line: 100 × 1, line margin 20%, line discount 0 → unit 120 → line total 120
  // quote: margin 0, discount 10%, shipping 0
  // afterMargin = 120, discount = 12, taxableBase = 108, ITBIS = 19.44
  // grandTotal = 108 + 19.44 = 127.44
  const t = computeTotals(
    [{ qty: 1, basePrice: 100, lineMarginPct: 20, lineDiscountPct: 0 }],
    { discountPct: 10 },
  );
  assert.equal(t.subtotal, 120);
  assert.equal(Math.round(t.grandTotal * 100) / 100, 127.44);
});

test('computeTotals: negative shipping is clamped to 0', () => {
  const t = computeTotals(
    [{ qty: 1, basePrice: 100, lineMarginPct: 0, lineDiscountPct: 0 }],
    { shipping: -50 },
  );
  assert.equal(t.shipping, 0);
});

test('computeTotals: discount over 100 clamped to 100', () => {
  // Subtotal 100, discount 150% → effective 100%, taxableBase 0, ITBIS 0
  const t = computeTotals(
    [{ qty: 1, basePrice: 100, lineMarginPct: 0, lineDiscountPct: 0 }],
    { discountPct: 150 },
  );
  assert.equal(t.taxableBase, 0);
  assert.equal(t.taxAmt, 0);
  assert.equal(t.grandTotal, 0);
});

test('computeTotals: NaN line qty is treated as 0', () => {
  const t = computeTotals(
    [{ qty: NaN, basePrice: 100, lineMarginPct: 0, lineDiscountPct: 0 }],
    {},
  );
  assert.equal(t.subtotal, 0);
  assert.equal(t.grandTotal, 0);
  assert.ok(Number.isFinite(t.grandTotal));
});

test('computeTotals: every returned field is finite', () => {
  // Adversarial inputs: NaN, Infinity, undefined, negative shipping
  const t = computeTotals(
    [
      { qty: NaN, basePrice: Infinity, lineMarginPct: undefined, lineDiscountPct: -5 },
      { qty: 1, basePrice: 50, lineMarginPct: NaN, lineDiscountPct: NaN },
    ],
    { marginPct: NaN, discountPct: 999, shipping: -100 },
  );
  for (const k of ['subtotal', 'marginAmt', 'discountAmt', 'taxableBase', 'taxAmt', 'shipping', 'grandTotal']) {
    assert.ok(Number.isFinite(t[k]), `expected ${k} to be finite, got ${t[k]}`);
  }
});

test('computeTotals: null lines argument behaves like empty', () => {
  const t = computeTotals(null, {});
  assert.equal(t.subtotal, 0);
  assert.equal(t.grandTotal, 0);
});

/* ----------------------- resolveLineBasePrice ------------------------- */

test('resolveLineBasePrice: priceOverride wins outright', () => {
  const r = resolveLineBasePrice({
    variant: { priceByGrade: { A: 100 } },
    material: { grade: 'A' },
    priceOverride: 42,
  });
  assert.equal(r, 42);
});

test('resolveLineBasePrice: variant + grade looks up grade column', () => {
  const r = resolveLineBasePrice({
    variant: { priceByGrade: { A: 100, B: 150 } },
    material: { grade: 'B' },
  });
  assert.equal(r, 150);
});

test('resolveLineBasePrice: priceFixed used when no grade lookup applies', () => {
  const r = resolveLineBasePrice({
    variant: { priceFixed: 200 },
    material: null,
  });
  assert.equal(r, 200);
});

test('resolveLineBasePrice: fallbackToLowestGrade returns min grade when no material', () => {
  const r = resolveLineBasePrice(
    { variant: { priceByGrade: { B: 150, A: 100, C: 200 } }, material: null },
    { fallbackToLowestGrade: true },
  );
  assert.equal(r, 100);
});

test('resolveLineBasePrice: missing grade column returns 0', () => {
  const r = resolveLineBasePrice({
    variant: { priceByGrade: { A: 100 } },
    material: { grade: 'Z' },
  });
  assert.equal(r, 0);
});

test('variantPriceForGrade: missing variant returns null', () => {
  assert.equal(variantPriceForGrade(null, 'A'), null);
  assert.equal(variantPriceForGrade({}, 'A'), null);
});
