/**
 * Tests for src/lib/swatchMatch.js — the logic that decides which catalog
 * material + color a quote line's swatch should be remembered against.
 * Pure (no DB), so the matching contract is pinned independent of Supabase.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  colorCodeFromSubtype,
  materialNameFromSubtype,
  locateColor,
} from '../src/lib/swatchMatch.js';

const MATERIALS = [
  {
    id: 'm1', name: 'DIVA', grade: 'C',
    colors: [
      { name: 'Velvet Smoke', code: '4479', imageId: null },
      { name: 'Ash', code: '5312', imageId: 'img-existing' },
    ],
  },
  {
    id: 'm2', name: 'CHARTRES', grade: 'D',
    colors: [
      // Deliberately reuses code 4479 to exercise name-based disambiguation.
      { name: 'Indigo', code: '4479', imageId: null },
    ],
  },
];

test('colorCodeFromSubtype — extracts the picker code', () => {
  assert.equal(colorCodeFromSubtype('Grade C — DIVA · Velvet Smoke (#4479)'), '4479');
  assert.equal(colorCodeFromSubtype('Grade D — CHARTRES · Indigo (#4479)'), '4479');
});

test('colorCodeFromSubtype — null for hand-typed fabrics (no code)', () => {
  assert.equal(colorCodeFromSubtype('Grade C — PAMPA'), null);
  assert.equal(colorCodeFromSubtype('Walnut'), null);
  assert.equal(colorCodeFromSubtype(''), null);
  assert.equal(colorCodeFromSubtype(null), null);
});

test('materialNameFromSubtype — name before the color', () => {
  assert.equal(materialNameFromSubtype('Grade C — DIVA · Velvet Smoke (#4479)'), 'DIVA');
  assert.equal(materialNameFromSubtype('Grade C — PAMPA'), 'PAMPA');
});

test('locateColor — matches by code', () => {
  const hit = locateColor(MATERIALS, 'Grade C — DIVA · Velvet Smoke (#4479)');
  assert.equal(hit.material.id, 'm1');
  assert.equal(hit.idx, 0);
});

test('locateColor — disambiguates a shared code by material name', () => {
  // Both DIVA and CHARTRES carry code 4479; the name in the subtype wins.
  const hit = locateColor(MATERIALS, 'Grade D — CHARTRES · Indigo (#4479)');
  assert.equal(hit.material.id, 'm2');
  assert.equal(hit.idx, 0);
});

test('locateColor — null when nothing matches or no code', () => {
  assert.equal(locateColor(MATERIALS, 'Grade C — DIVA · Nope (#9999)'), null);
  assert.equal(locateColor(MATERIALS, 'Grade C — PAMPA'), null);
  assert.equal(locateColor([], 'Grade C — DIVA · Velvet Smoke (#4479)'), null);
});

test('locateColor — still points at a color that already has a photo (caller decides fill-empty)', () => {
  const hit = locateColor(MATERIALS, 'Grade C — DIVA · Ash (#5312)');
  assert.equal(hit.material.id, 'm1');
  assert.equal(hit.idx, 1);
  assert.equal(hit.material.colors[hit.idx].imageId, 'img-existing');
});
