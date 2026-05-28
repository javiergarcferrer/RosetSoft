/**
 * Tests for src/lib/swatchImage.ts — deriving a Ligne Roset swatch URL from a
 * catalog color code. Pure (no DB), so the URL contract is pinned regardless
 * of Supabase. The path format is load-bearing: it's keyed on the exact
 * `code` we store, so a change here silently empties every catalog swatch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { swatchUrl, heroSwatchUrl } from '../src/lib/swatchImage.js';

const BASE = 'https://www.ligne-roset.com/media/ligne_roset_us/colorized-pattern';

test('swatchUrl — builds c_{code}.jpg from a color code', () => {
  assert.equal(swatchUrl('4479'), `${BASE}/c_4479.jpg`);
  assert.equal(swatchUrl('855'), `${BASE}/c_855.jpg`);
});

test('swatchUrl — trims surrounding whitespace', () => {
  assert.equal(swatchUrl('  4479 '), `${BASE}/c_4479.jpg`);
});

test('swatchUrl — null for empty / missing codes', () => {
  assert.equal(swatchUrl(''), null);
  assert.equal(swatchUrl('   '), null);
  assert.equal(swatchUrl(null), null);
  assert.equal(swatchUrl(undefined), null);
});

test('swatchUrl — coerces a numeric code (defensive against JS callers)', () => {
  assert.equal(swatchUrl(4479), `${BASE}/c_4479.jpg`);
});

test('swatchUrl — URL-encodes unusual characters', () => {
  assert.equal(swatchUrl('A/B'), `${BASE}/c_A%2FB.jpg`);
  assert.equal(swatchUrl('A B'), `${BASE}/c_A%20B.jpg`);
});

test('heroSwatchUrl — first color’s swatch', () => {
  const material = { colors: [{ code: '4479' }, { code: '5312' }] };
  assert.equal(heroSwatchUrl(material), `${BASE}/c_4479.jpg`);
});

test('heroSwatchUrl — null when no colors / no code / no material', () => {
  assert.equal(heroSwatchUrl({ colors: [] }), null);
  assert.equal(heroSwatchUrl({ colors: [{ code: '' }] }), null);
  assert.equal(heroSwatchUrl({}), null);
  assert.equal(heroSwatchUrl(null), null);
  assert.equal(heroSwatchUrl(undefined), null);
});
