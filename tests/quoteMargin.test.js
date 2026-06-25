/**
 * Tests for quoteMargin (src/core/quote/totals.js) — the per-product margin
 * roll-up shown (interno) on a company-account order.
 *
 * The invariant that matters: the margin is the catalog LIST value vs the real
 * catalog COST (each line's frozen `unitCost` — the per-SKU "63%" the Catálogo
 * shows), summed over the PRICED lines, and a line that can't carry a per-product
 * cost (a compound, or a hand-typed line with none) is EXCLUDED from the figures
 * and merely counted — so the readout never quotes a margin that silently
 * dropped half the order.
 *
 * Run with `npm test` (node:test + node:assert, via tsx).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { quoteMargin } from '../src/core/quote/totals.js';

test('sums list vs catalog cost into profit + blended margin %', () => {
  const m = quoteMargin([
    { id: 'l1', kind: 'item', qty: 2, unitPrice: 1000, unitCost: 370 }, // 63% margin
    { id: 'l2', kind: 'item', qty: 1, unitPrice: 500, unitCost: 250 },  // 50% margin
  ]);
  assert.equal(m.sell, 2500);          // 1000×2 + 500
  assert.equal(m.cost, 990);           // 370×2 + 250
  assert.equal(m.profit, 1510);
  assert.equal(Math.round(m.marginPct), 60);
  assert.equal(m.linesPriced, 2);
  assert.equal(m.linesWithCost, 2);
});

test('uses the catalog LIST price, not a line-level discount, for the product margin', () => {
  // A one-off line discount is a quote concession, not the product's margin —
  // sell stays the catalog list so the figure reflects the SKU's 63%.
  const m = quoteMargin([
    { id: 'l1', kind: 'item', qty: 1, unitPrice: 1000, unitCost: 370, lineDiscountPct: 20 },
  ]);
  assert.equal(m.sell, 1000);
  assert.equal(m.cost, 370);
  assert.equal(Math.round(m.marginPct), 63);
});

test('excludes sections, optionals, compounds and cost-less lines (but counts coverage)', () => {
  const m = quoteMargin([
    { id: 's', kind: 'section', name: 'Sala' },                                            // not priced
    { id: 'l1', kind: 'item', qty: 1, unitPrice: 1000, unitCost: 400 },                    // counts
    { id: 'l2', kind: 'item', qty: 1, unitPrice: 800, unitCost: 300, isOptional: true },   // excluded optional → not priced
    { id: 'l3', kind: 'item', qty: 1, unitPrice: 600 },                                    // priced, but no cost
    { id: 'l4', kind: 'item', qty: 1, unitPrice: 0, unitCost: 0,                            // compound: components carry no cost
      components: [{ id: 'c', qty: 1, unitPrice: 500 }] },
  ]);
  assert.equal(m.sell, 1000);          // only l1
  assert.equal(m.cost, 400);
  assert.equal(m.linesPriced, 3);      // l1, l3, l4 (l2 is an excluded optional)
  assert.equal(m.linesWithCost, 1);    // only l1 carries a real catalog cost
});

test('a zero / non-finite cost is treated as "no cost", not a 100% margin', () => {
  const m = quoteMargin([
    { id: 'l1', kind: 'item', qty: 1, unitPrice: 900, unitCost: 0 },
    { id: 'l2', kind: 'item', qty: 1, unitPrice: 900 },
  ]);
  assert.equal(m.linesWithCost, 0);
  assert.equal(m.sell, 0);
  assert.equal(m.marginPct, 0);        // no division-by-zero, no fake 100%
});

test('empty / null input is a zeroed roll-up', () => {
  for (const input of [[], null, undefined]) {
    const m = quoteMargin(input);
    assert.deepEqual(m, { sell: 0, cost: 0, profit: 0, marginPct: 0, linesPriced: 0, linesWithCost: 0 });
  }
});
