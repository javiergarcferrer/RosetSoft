/**
 * Tests for allocateShipment (src/lib/accounting/importLiquidation.js) — the
 * batch import liquidation that spreads a shipment's duty + clearance + other
 * costs over its pieces by CIP weight, giving each a landed unit cost for the
 * kardex. Recoverable import ITBIS is carried through, not capitalized.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { allocateShipment } from '../src/lib/accounting/importLiquidation.js';

const sum = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;

test('spreads extras by CIP weight; Σ shares and Σ landed are exact', () => {
  const lines = [
    { quantity: 1, unitCostUsd: 1488.40 },
    { quantity: 1, unitCostUsd: 1336.49 },
    { quantity: 1, unitCostUsd: 1373.02 },
  ];
  const a = allocateShipment(lines, { duty: 839.58, clearanceFees: 200, otherCosts: 0, importItbis: 0 });
  assert.equal(a.totalCip, 4197.91);
  assert.equal(a.landedTotal, 5237.49); // 4197.91 + 1039.58
  // shares sum to the full spread, landed totals sum to landedTotal
  assert.equal(sum(a.pieces.map((p) => p.allocatedExtras)), 1039.58);
  assert.equal(sum(a.pieces.map((p) => p.landedTotal)), 5237.49);
  // proportional: the most expensive piece carries the largest share
  assert.ok(a.pieces[0].allocatedExtras > a.pieces[1].allocatedExtras);
  // landed unit cost = landedTotal / qty
  for (const p of a.pieces) assert.equal(p.landedUnitCost, Math.round((p.landedTotal / p.line.quantity) * 10000) / 10000);
});

test('rounding drift is absorbed by the last piece (Σ === spread)', () => {
  const lines = [
    { quantity: 1, unitCostUsd: 100 },
    { quantity: 1, unitCostUsd: 100 },
    { quantity: 1, unitCostUsd: 100 },
  ];
  const a = allocateShipment(lines, { duty: 10 });
  assert.deepEqual(a.pieces.map((p) => p.allocatedExtras), [3.33, 3.33, 3.34]);
  assert.equal(sum(a.pieces.map((p) => p.allocatedExtras)), 10);
});

test('quantity > 1 → landed unit cost divides the landed total', () => {
  const a = allocateShipment([{ quantity: 2, unitCostUsd: 100 }], { duty: 20 });
  assert.equal(a.pieces[0].cipValue, 200);
  assert.equal(a.pieces[0].landedTotal, 220);
  assert.equal(a.pieces[0].landedUnitCost, 110);
});

test('drops pieces with no quantity or no unit cost', () => {
  const a = allocateShipment([
    { quantity: 0, unitCostUsd: 500 },
    { quantity: 1, unitCostUsd: 0 },
    { quantity: 1, unitCostUsd: 250 },
  ], { duty: 50 });
  assert.equal(a.pieces.length, 1);
  assert.equal(a.pieces[0].cipValue, 250);
  assert.equal(a.pieces[0].allocatedExtras, 50);
});

test('import ITBIS is carried through, never capitalized into landed cost', () => {
  const a = allocateShipment([{ quantity: 1, unitCostUsd: 1000 }], { duty: 200, importItbis: 216 });
  assert.equal(a.importItbis, 216);
  assert.equal(a.landedTotal, 1200); // CIP 1000 + duty 200, ITBIS excluded
  assert.equal(a.pieces[0].landedTotal, 1200);
});
