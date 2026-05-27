/**
 * Tests for src/lib/catalog.js — family grouping of catalog products by SKU
 * root, with the trailing letter as the fabric grade.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitSkuGrade, groupFamilies, availableGrades, productForGrade } from '../src/lib/catalog.js';

/* ------------------------------ splitSkuGrade ------------------------------ */

test('splits an 8-digit root + grade letter', () => {
  assert.deepEqual(splitSkuGrade('15420000A'), { root: '15420000', grade: 'A' });
  assert.deepEqual(splitSkuGrade('15420000S'), { root: '15420000', grade: 'S' });
  assert.deepEqual(splitSkuGrade('15420000U'), { root: '15420000', grade: 'U' });
});

test('rejects T/Y/Z (not in the grade taxonomy) — treats as ungraded', () => {
  // The price list skips T/Y/Z; such a tail is not a grade.
  assert.deepEqual(splitSkuGrade('15420000T'), { root: '15420000T', grade: '' });
});

test('leaves non-graded codes whole (alphanumeric tables, etc.)', () => {
  assert.deepEqual(splitSkuGrade('00A0AM20'), { root: '00A0AM20', grade: '' });
  assert.deepEqual(splitSkuGrade('0050W49N'), { root: '0050W49N', grade: '' });
});

/* ------------------------------ groupFamilies ------------------------------ */

const TOGO = [
  { reference: '15420000A', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 3420, cost: 1243.64 },
  { reference: '15420000G', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 4450, cost: 1618.18 },
  { reference: '15420000M', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 5140, cost: 1869.09 },
  { reference: '15420000U', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 4145, cost: 1507.27 },
  { reference: '15420000S', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 4760, cost: 1730.91 },
  // an unrelated wood chair (distinct root, ungraded)
  { reference: '10261152W', name: 'VIK CHAIR W/ARMS', family: 'DINING CHAIRS', priceUsd: 2165, cost: 807.84 },
];

test('groups grade variants under one family root', () => {
  const fams = groupFamilies(TOGO);
  const togo = fams.find((f) => f.root === '15420000');
  assert.ok(togo);
  assert.equal(togo.name, 'TOGO FIRESIDE CHAIR');
  assert.equal(togo.graded, true);
  assert.equal(togo.byGrade.size, 5);
});

test('orders available grades by ascending price', () => {
  const togo = groupFamilies(TOGO).find((f) => f.root === '15420000');
  // prices: A 3420 < U 4145 < G 4450 < S 4760 < M 5140
  assert.deepEqual(availableGrades(togo), ['A', 'U', 'G', 'S', 'M']);
});

test('resolves a model + grade to the right SKU price/cost', () => {
  const togo = groupFamilies(TOGO).find((f) => f.root === '15420000');
  assert.equal(productForGrade(togo, 'G').reference, '15420000G');
  assert.equal(productForGrade(togo, 'G').priceUsd, 4450);
  assert.equal(productForGrade(togo, 'M').priceUsd, 5140);
});

test('a lone SKU ending in a grade letter is a standalone (not graded) family', () => {
  // VIK's W tail is a wood finish, not a fabric grade — and no sibling shares
  // its 8-digit root, so the ≥2-variant rule keeps it standalone.
  const vik = groupFamilies(TOGO).find((f) => f.root === '10261152');
  assert.ok(vik);
  assert.equal(vik.graded, false);
  assert.deepEqual(availableGrades(vik), []);
  assert.equal(productForGrade(vik, '').reference, '10261152W');
});
