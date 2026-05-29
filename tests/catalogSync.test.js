// Tests for src/lib/catalogSync.js — stacking the website sync and the price-
// list PDF into one set of catalog changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCatalog } from '../src/lib/catalogSync.js';

const ctx = (over) => { let n = 0; return { profileId: 'team', now: 1000, newId: () => `n${++n}`, ...over }; };
const pdf = (over = {}) => ({
  name: 'ACATE', category: 'fabric', grade: 'A', wearRating: null, wearDoubleRubs: null,
  measure: 55, measureUnit: 'in', price: 73, priceUnit: 'yard', composition: 'COTTON 80%', ...over,
});

test('stacks website colors + PDF spec into one new material', () => {
  const site = [{ name: 'ACATE', type: 'Fabrics', colors: [{ code: '855', name: 'ANIS' }] }];
  const { rows, deleteIds, summary } = syncCatalog([], site, [pdf()], ctx());
  assert.equal(deleteIds.length, 0);
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.grade, 'A');                              // PDF owns spec
  assert.equal(m.price, 73);
  assert.equal(m.composition, 'COTTON 80%');
  assert.deepEqual(m.colors.map((c) => c.code), ['855']);  // website owns colors
  assert.equal(summary.newMaterials, 1);
  assert.equal(summary.colorsAdded, 1);
  assert.equal(summary.siteSynced, true);
});

test('works PDF-only when the website is unreachable', () => {
  const { rows, summary } = syncCatalog([], null, [pdf({ composition: null })], ctx());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grade, 'A');
  assert.equal(rows[0].colors.length, 0);
  assert.equal(summary.siteSynced, false);
});


test('a material in the price list is un-flagged "no en sitio" even if the site scraper missed it', () => {
  // ARDA is flagged discontinued and the website sweep doesn't return it (a
  // scraper gap) — but it IS in the price list, so it must un-flag.
  const existing = [{ id: 'a', profileId: 'team', category: 'fabric', name: 'ARDA',
    discontinuedAt: 500, colors: [{ name: 'X', code: '1', imageId: 'p' }], createdAt: 1, updatedAt: 1 }];
  const { rows, summary } = syncCatalog(existing, [], [pdf({ name: 'ARDA', composition: null })], ctx());
  const arda = rows.find((r) => r.id === 'a');
  assert.equal(arda.discontinuedAt, null); // no longer "no en sitio"
  assert.equal(arda.grade, 'A');
  assert.equal(summary.flaggedNoSite, 0);  // the website sync never flags
});
