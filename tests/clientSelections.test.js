/**
 * Tests for src/lib/clientSelections.js — the pure transform that folds a
 * share-link recipient's picks (alternatives, optionals, materials) into the
 * line set the public preview + totals consume.
 *
 * Run with `npm test`. Node's built-in test runner + node:assert.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyClientSelections } from '../src/lib/clientSelections.js';

/* ----------------------------- alternatives --------------------------- */

test('alternatives: the picked member becomes the selected one', () => {
  const lines = [
    { id: 'a', alternativeGroup: 'g', isSelectedAlternative: true },
    { id: 'b', alternativeGroup: 'g', isSelectedAlternative: false },
  ];
  const out = applyClientSelections(lines, { alternatives: { g: 'b' } });
  assert.equal(out.find((l) => l.id === 'a').isSelectedAlternative, false);
  assert.equal(out.find((l) => l.id === 'b').isSelectedAlternative, true);
});

test('alternatives: with no pick, the dealer default is untouched', () => {
  const lines = [
    { id: 'a', alternativeGroup: 'g', isSelectedAlternative: true },
    { id: 'b', alternativeGroup: 'g', isSelectedAlternative: false },
  ];
  const out = applyClientSelections(lines, {});
  assert.equal(out.find((l) => l.id === 'a').isSelectedAlternative, true);
  assert.equal(out.find((l) => l.id === 'b').isSelectedAlternative, false);
});

/* ------------------------------- optionals ---------------------------- */

test('optionals: an included optional un-flags so it counts', () => {
  const lines = [{ id: 'o', isOptional: true }];
  const out = applyClientSelections(lines, { optionals: { o: true } });
  assert.equal(out[0].isOptional, false);
});

test('optionals: an excluded optional stays optional', () => {
  const lines = [{ id: 'o', isOptional: true }];
  const out = applyClientSelections(lines, { optionals: { o: false } });
  assert.equal(out[0].isOptional, true);
});

/* ------------------------------- materials ---------------------------- */

const lineWithMaterials = () => ({
  id: 'sofa',
  unitPrice: 1000,
  materialOptions: {
    baseGrade: 'C',
    baseLabel: 'PHLOX',
    options: [
      { grade: 'L', label: 'Cuero L', delta: 420 },
      { grade: 'A', label: 'Tela A', delta: -120 },
      { grade: 'Z', label: 'Sin precio' }, // no delta → label-only
    ],
  },
});

test('materials: picking a pricier grade lifts the unit price by its delta', () => {
  const out = applyClientSelections([lineWithMaterials()], { materials: { sofa: 'L' } });
  assert.equal(out[0].unitPrice, 1420);
});

test('materials: picking a cheaper grade lowers the unit price', () => {
  const out = applyClientSelections([lineWithMaterials()], { materials: { sofa: 'A' } });
  assert.equal(out[0].unitPrice, 880);
});

test('materials: the base grade is a no-op', () => {
  const out = applyClientSelections([lineWithMaterials()], { materials: { sofa: 'C' } });
  assert.equal(out[0].unitPrice, 1000);
});

test('materials: an unknown / delta-less grade leaves the price untouched', () => {
  const unknown = applyClientSelections([lineWithMaterials()], { materials: { sofa: 'Q' } });
  assert.equal(unknown[0].unitPrice, 1000);
  const noDelta = applyClientSelections([lineWithMaterials()], { materials: { sofa: 'Z' } });
  assert.equal(noDelta[0].unitPrice, 1000);
});

test('materials: a compound component is re-priced by component id', () => {
  const lines = [{
    id: 'compound',
    components: [
      {
        id: 'seat',
        unitPrice: 500,
        materialOptions: { baseGrade: 'C', options: [{ grade: 'L', label: 'Cuero', delta: 200 }] },
      },
      { id: 'ottoman', unitPrice: 300 },
    ],
  }];
  const out = applyClientSelections(lines, { materials: { seat: 'L' } });
  assert.equal(out[0].components[0].unitPrice, 700);
  assert.equal(out[0].components[1].unitPrice, 300); // untouched
});

test('materials + alternatives compose on the same line', () => {
  const lines = [
    {
      id: 'a', alternativeGroup: 'g', isSelectedAlternative: false, unitPrice: 1000,
      materialOptions: { baseGrade: 'C', options: [{ grade: 'L', label: 'Cuero', delta: 420 }] },
    },
  ];
  const out = applyClientSelections(lines, { alternatives: { g: 'a' }, materials: { a: 'L' } });
  assert.equal(out[0].isSelectedAlternative, true);
  assert.equal(out[0].unitPrice, 1420);
});

test('applyClientSelections: null inputs are safe', () => {
  assert.deepEqual(applyClientSelections(null, null), []);
  assert.deepEqual(applyClientSelections([], { materials: { x: 'L' } }), []);
});
