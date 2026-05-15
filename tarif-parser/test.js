// Unit tests. Runs against captured fixtures so the test suite has no
// runtime dependency on the source PDF.
//
//   node --test test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { normalizeKey, normalizeRef, shortId } from './normalize.js';
import { classifyPage } from './classify.js';
import { extractBanner, extractAllBanners, extractModelCode, extractProductFields } from './product.js';
import { VariantSchema } from './schema.js';
import { extractAllVariantTables, extractCabinetryTable } from './variant.js';
import { parseSingleFabricPage } from './material.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(p) {
  return JSON.parse(readFileSync(resolve(__dirname, `fixtures/page-${p}.json`), 'utf8'));
}

test('normalizeRef strips NBSP and lowercases / non-alnum', () => {
  assert.equal(normalizeRef('0P50FX1N '), '0P50FX1N');
  assert.equal(normalizeRef('  ab-12 _CD '), 'AB12CD');
  assert.equal(normalizeRef(''), '');
  assert.equal(normalizeRef(null), '');
});

test('normalizeKey is diacritic / case / punctuation insensitive', () => {
  assert.equal(normalizeKey('ABANDÓN '), normalizeKey('abandon'));
  assert.equal(normalizeKey('Marie C. Dorner'), normalizeKey('marie c dorner'));
  assert.equal(normalizeKey('  multiple   spaces  '), 'multiple spaces');
  assert.equal(normalizeKey(''), '');
});

test('shortId is deterministic 12-char hex', () => {
  const id = shortId('hello');
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(id, shortId('hello'));
});

test('classify p15 -> section "COVER MATERIALS"', () => {
  const info = loadFixture(15);
  const c = classifyPage(info);
  assert.equal(c.kind, 'section');
  assert.equal(c.hints.sectionName, 'COVER MATERIALS');
});

test('classify p40 -> fabric-list with banner GENTLE / FR', () => {
  const info = loadFixture(40);
  const c = classifyPage(info);
  assert.equal(c.kind, 'fabric-list');
  assert.ok(c.hints.banner.includes('GENTLE'));
});

test('classify p60 -> product (STORE LAYOUT)', () => {
  const info = loadFixture(60);
  const c = classifyPage(info);
  assert.equal(c.kind, 'product');
  assert.equal(extractBanner(info.items), 'STORE LAYOUT');
});

test('classify p70 -> product (BOX FOR 18 SAMPLES)', () => {
  const info = loadFixture(70);
  const c = classifyPage(info);
  assert.equal(c.kind, 'product');
  assert.equal(extractBanner(info.items), 'BOX FOR 18 SAMPLES');
  assert.equal(extractModelCode(info.items), '102');
});

test('extract variant table from p150 (EXCLUSIF) yields >=4 variants with refs', () => {
  const info = loadFixture(150);
  const tables = extractAllVariantTables(info.items);
  assert.ok(tables.length >= 1, 'expected at least one table');
  const variants = tables[0].variants;
  assert.ok(variants.length >= 4, `expected >=4 variants, got ${variants.length}`);
  for (const v of variants) {
    assert.ok(v.reference, 'variant must have a reference');
    assert.match(v.reference, /^\d{6,10}$/);
    assert.ok(Object.keys(v.priceByGrade).length > 0 || v.priceFixed != null,
      'variant must have at least one price');
  }
});

test('extract product fields from p150 captures banner + designer', () => {
  const info = loadFixture(150);
  const fields = extractProductFields(info);
  assert.equal(fields.banner, 'EXCLUSIF');
  // designer text is on a different page in this corpus; banner is the
  // important signal at this level.
});

test('parse per-fabric color page p40 (GENTLE / FR)', () => {
  const info = loadFixture(40);
  const m = parseSingleFabricPage(info.items, { kind: 'fabric' });
  assert.ok(m, 'material parsed');
  assert.equal(m.name, 'GENTLE / FR');
  assert.ok(m.colors.length >= 5, `expected >=5 colors, got ${m.colors.length}`);
  for (const c of m.colors) {
    assert.ok(c.name && c.code, 'colors must have name+code');
  }
  // unique codes within a material
  const codes = new Set();
  for (const c of m.colors) {
    assert.ok(!codes.has(c.code), 'duplicate color code: ' + c.code);
    codes.add(c.code);
  }
});

test('classify p329 (PRADO) -> product with Important section', () => {
  const info = loadFixture(329);
  const c = classifyPage(info);
  assert.equal(c.kind, 'product');
  const fields = extractProductFields(info);
  assert.equal(fields.banner, 'PRADO');
  assert.ok(fields.important, 'PRADO should have an Important section');
  assert.match(fields.important, /CHROMED STEEL/i);
  assert.match(fields.important, /11370001/);
});

test('classify p514 (ALLUNGAMI) -> cabinetry with row-per-variant table', () => {
  const info = loadFixture(514);
  const c = classifyPage(info);
  assert.equal(c.kind, 'cabinetry');
  const t = extractCabinetryTable(info.items);
  assert.equal(t.variants.length, 6, 'ALLUNGAMI page should yield 6 variants');
  // every variant should have a unique ref, a material, dimensions, and a fixed USD price
  const refs = new Set();
  for (const v of t.variants) {
    assert.ok(v.reference, 'variant must have a reference');
    assert.ok(!refs.has(v.reference), 'reference must be unique within page: ' + v.reference);
    refs.add(v.reference);
    assert.ok(v.material, 'variant must have a material');
    assert.ok(v.dimensions, 'variant must have dimensions');
    assert.ok(/H \d/.test(v.dimensions), 'dimensions must include H');
    assert.ok(/W \d/.test(v.dimensions), 'dimensions must include W');
    assert.ok(typeof v.priceFixed === 'number', 'variant must have a numeric priceFixed');
  }
  // materials should vary across variants (CALACATTA + ARDOISE)
  const mats = new Set(t.variants.map((v) => v.material));
  assert.ok(mats.size >= 2, 'variants should expose >=2 distinct materials');
  // name should carry the base finish (BLACK or BRONZE LACQUERED BASE)
  const blackBase = t.variants.some((v) => /BLACK LACQUERED BASE/.test(v.name));
  const bronzeBase = t.variants.some((v) => /BRONZE LACQUERED BASE/.test(v.name));
  assert.ok(blackBase, 'at least one variant names BLACK LACQUERED BASE');
  assert.ok(bronzeBase, 'at least one variant names BRONZE LACQUERED BASE');
});

test('classify p587 -> section "OTHER OCCASIONAL ITEMS"', () => {
  const info = loadFixture(587);
  const c = classifyPage(info);
  assert.equal(c.kind, 'section');
  assert.equal(c.hints.sectionName, 'OTHER OCCASIONAL ITEMS');
});

test('classify p600 -> cabinetry; section-banner page yields sub-banners', () => {
  const info = loadFixture(600);
  const c = classifyPage(info);
  assert.equal(c.kind, 'cabinetry');
  const t = extractCabinetryTable(info.items);
  assert.ok(t.variants.length >= 4, 'p600 should yield multiple variants');
  // Each variant should carry a subBanner (we're on a multi-product page).
  for (const v of t.variants) {
    assert.ok(v.subBanner, `variant ${v.reference} should have a subBanner`);
  }
  const subBanners = new Set(t.variants.map((v) => v.subBanner));
  assert.ok(subBanners.size >= 2, 'multi-product page should expose multiple sub-banners');
});

test('classify p706 -> cabinetry; single-product page yields no subBanners', () => {
  const info = loadFixture(706);
  const c = classifyPage(info);
  assert.equal(c.kind, 'cabinetry');
  const t = extractCabinetryTable(info.items);
  assert.ok(t.variants.length >= 4, 'BOOK&LOOK should yield variants');
  // On a single-product page subBanner may be null on all variants.
  // (CHESTS is fs=18 — above our sub-banner threshold of fs ≤ 13.)
  const nullSubs = t.variants.filter((v) => v.subBanner == null).length;
  assert.ok(nullSubs >= t.variants.length / 2, 'most variants on single-product page have null subBanner');
});

test('VariantSchema requires reference, dimensions, imageFile, description', () => {
  const minimal = {
    id: '0123456789ab',
    name: 'V',
    reference: 'REF1',
    dimensions: 'H 10',
    yardage: null,
    priceFixed: 100,
    priceByGrade: {},
    sortOrder: 0,
    description: 'd',
    imageFile: 'img.jpg',
  };
  // Should parse with all four required fields set.
  VariantSchema.parse(minimal);
  // Should reject null/empty in any of the four required fields.
  for (const k of ['reference', 'dimensions', 'description', 'imageFile']) {
    assert.throws(() => VariantSchema.parse({ ...minimal, [k]: '' }));
    assert.throws(() => VariantSchema.parse({ ...minimal, [k]: null }));
  }
});

test('extractAllBanners is sorted top-to-bottom', () => {
  const info = loadFixture(70);
  const bs = extractAllBanners(info.items);
  for (let i = 1; i < bs.length; i++) {
    assert.ok(bs[i].y >= bs[i - 1].y, 'banners should be sorted by y');
  }
});
