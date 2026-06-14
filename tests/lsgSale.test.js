import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lsgSaleAdjustments } from '../src/lib/lsgSale.js';

// reference (SKU) → LSG product id (lsg-<variantId>)
const byRef = new Map([
  ['LSG-AAA', 'lsg-111'],
  ['LSG-BBB', 'lsg-222'],
  ['LSG-CCC', 'lsg-333'],
]);

test('a priced simple LSG line decrements by its quantity (negative delta)', () => {
  const adj = lsgSaleAdjustments([{ kind: 'item', reference: 'LSG-AAA', qty: 2 }], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -2 }]);
});

test('Ligne Roset / free-typed references (absent from the map) are ignored', () => {
  const adj = lsgSaleAdjustments([
    { kind: 'item', reference: 'LR-SOFA', qty: 1 },
    { kind: 'item', reference: 'LSG-AAA', qty: 1 },
  ], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -1 }]);
});

test('optional, non-selected-alternative, and section lines never decrement', () => {
  const adj = lsgSaleAdjustments([
    { kind: 'item', reference: 'LSG-AAA', qty: 1, isOptional: true },
    { kind: 'item', reference: 'LSG-BBB', qty: 1, alternativeGroup: 'g1', isSelectedAlternative: false },
    { kind: 'section', reference: 'LSG-CCC', qty: 1 },
  ], byRef);
  assert.deepEqual(adj, []);
});

test('the selected alternative IS counted', () => {
  const adj = lsgSaleAdjustments([
    { kind: 'item', reference: 'LSG-AAA', qty: 1, alternativeGroup: 'g1', isSelectedAlternative: true },
    { kind: 'item', reference: 'LSG-BBB', qty: 1, alternativeGroup: 'g1', isSelectedAlternative: false },
  ], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -1 }]);
});

test('compound: priced components count (folding line qty); optional ones do not', () => {
  const adj = lsgSaleAdjustments([{
    kind: 'item', reference: 'LSG-AAA', qty: 2,
    components: [
      { reference: 'LSG-BBB', qty: 1 },                 // priced → 2*1
      { reference: 'LSG-CCC', qty: 3, isOptional: true }, // optional → skip
    ],
  }], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-222', delta: -2 }]);
});

test('the same variant across lines/components is summed once', () => {
  const adj = lsgSaleAdjustments([
    { kind: 'item', reference: 'LSG-AAA', qty: 1 },
    { kind: 'item', reference: 'LSG-AAA', qty: 2 },
  ], byRef);
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -3 }]);
});

test('accepts a plain object map as well as a Map', () => {
  const adj = lsgSaleAdjustments(
    [{ kind: 'item', reference: 'LSG-AAA', qty: 1 }],
    { 'LSG-AAA': 'lsg-111' },
  );
  assert.deepEqual(adj, [{ productId: 'lsg-111', delta: -1 }]);
});

test('empty / missing inputs yield no adjustments', () => {
  assert.deepEqual(lsgSaleAdjustments([], byRef), []);
  assert.deepEqual(lsgSaleAdjustments(null, byRef), []);
});
