/**
 * Tests for src/lib/materialsPdf.ts — parsing the Ligne Roset price-list PDF
 * (via normalized text items) and merging it into the catalog as the
 * source of truth for commercial spec.
 *
 * The parser is exercised against a REAL fixture captured from the
 * 05.2026 USA materials PDF (page 1 = the FABRICS table).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseMaterialsPdf, mergePriceList } from '../src/lib/materialsPdf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE0 = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/materialsPdf.page0.json'), 'utf8'));

const byName = (mats, n) => mats.find((m) => m.name === n);

/* -------------------------------- parser ----------------------------------- */

test('parses the real FABRICS page into materials with every spec field', () => {
  const mats = parseMaterialsPdf(PAGE0);
  assert.equal(mats.length, 10);

  const acate = byName(mats, 'ACATE');
  assert.equal(acate.category, 'fabric');
  assert.equal(acate.grade, 'A');
  assert.equal(acate.wearRating, '3C');
  assert.equal(acate.wearDoubleRubs, 50000);
  assert.equal(acate.measure, 55);
  assert.equal(acate.measureUnit, 'in');
  assert.equal(acate.price, 73);
  assert.equal(acate.priceUnit, 'yard');
  assert.equal(acate.composition, 'COTTON 80%, POLYESTER 20%');

  // grade S / $363 / 56" / 3C / 30000 — matches the dealer's prior parse.
  const alc = byName(mats, 'ALCANTARA - A');
  assert.equal(alc.grade, 'S');
  assert.equal(alc.price, 363);
  assert.equal(alc.measure, 56);
  assert.equal(alc.wearDoubleRubs, 30000);
  assert.ok(alc.composition.startsWith('POLYESTER 68%'));
});

test('reads ½ widths and the bold price column', () => {
  const mats = parseMaterialsPdf(PAGE0);
  assert.equal(byName(mats, 'AMALFI').measure, 54.5);   // "54½"
  assert.equal(byName(mats, 'ARA').measure, 53.5);
  assert.equal(byName(mats, 'AMALFI').price, 101);
  assert.equal(byName(mats, 'APPA/FR').price, 330);
});

test('auto-detects the +29 glyph cipher when items arrive un-decoded', () => {
  // Re-encode the fixture by shifting every char back by 29 (the raw glyph
  // codes a non-decoding extractor would yield) and confirm we still parse.
  const shiftBack = (s) => [...s].map((c) => {
    const o = c.charCodeAt(0);
    return o >= 0x20 && o <= 0x7e ? String.fromCharCode(o - 29) : c;
  }).join('');
  const raw = PAGE0.map((it) => ({ ...it, str: shiftBack(it.str) }));
  const mats = parseMaterialsPdf(raw);
  const acate = byName(mats, 'ACATE');
  assert.ok(acate, 'ACATE recovered from raw-shifted items');
  assert.equal(acate.price, 73);
  assert.equal(acate.grade, 'A');
});

/* ----------------------------- mergePriceList ------------------------------ */

function ctx(extra) {
  let n = 0;
  return { profileId: 'team', now: 1000, newId: () => `new-${++n}`, ...extra };
}

const PARSED = (over = {}) => ({
  name: 'ACATE', category: 'fabric', grade: 'A', wearRating: '3C', wearDoubleRubs: 50000,
  measure: 55, measureUnit: 'in', price: 73, priceUnit: 'yard', composition: 'COTTON 80%, POLYESTER 20%',
  ...over,
});

test('new material from the price list carries spec + empty colors', () => {
  const { rows, summary } = mergePriceList([], [PARSED()], ctx());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grade, 'A');
  assert.equal(rows[0].price, 73);
  assert.equal(rows[0].measure, 55);
  assert.deepEqual(rows[0].colors, []);            // website fills colors later
  assert.equal(rows[0].notInPricelistAt, null);
  assert.equal(summary.newMaterials, 1);
});

test('price list owns spec, preserves website colors/notes/photos', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE',
    grade: 'X', price: 1, measure: 1, composition: 'STALE',
    notes: 'care note from the website',
    colors: [{ name: 'ANIS', code: '855', imageId: 'photo-9' }],
    createdAt: 1, updatedAt: 1,
  }];
  const { rows } = mergePriceList(existing, [PARSED()], ctx());
  const m = rows[0];
  assert.equal(m.id, 'm1');
  assert.equal(m.grade, 'A');                       // overwritten from PDF
  assert.equal(m.price, 73);
  assert.equal(m.composition, 'COTTON 80%, POLYESTER 20%');
  // website-owned data survives untouched:
  assert.equal(m.notes, 'care note from the website');
  assert.deepEqual(m.colors, [{ name: 'ANIS', code: '855', imageId: 'photo-9' }]);
});

test('idempotent — re-importing the same price list changes nothing', () => {
  const first = mergePriceList([], [PARSED()], ctx());
  const second = mergePriceList(first.rows, [PARSED()], ctx());
  assert.equal(second.rows.length, 0);
  assert.equal(second.summary.unchangedMaterials, 1);
});

test('complete import flags (not deletes) a material absent from the price list', () => {
  const existing = [
    { id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE', colors: [], createdAt: 1, updatedAt: 1 },
    { id: 'm2', profileId: 'team', category: 'fabric', name: 'WEBSITE ONLY', grade: null,
      colors: [{ name: 'X', code: '1', imageId: 'p' }], createdAt: 1, updatedAt: 1 }, // not in PDF
  ];
  const { rows, summary } = mergePriceList(existing, [PARSED()], ctx({ complete: true }));
  const flagged = rows.find((r) => r.id === 'm2');
  assert.equal(flagged.notInPricelistAt, 1000);
  assert.deepEqual(flagged.colors, [{ name: 'X', code: '1', imageId: 'p' }]); // kept
  assert.equal(summary.flaggedMissing, 1);
});

test('a single-file (partial) import never flags absent materials', () => {
  const existing = [{ id: 'm2', profileId: 'team', category: 'fabric', name: 'OTHER', colors: [], createdAt: 1, updatedAt: 1 }];
  const { rows, summary } = mergePriceList(existing, [PARSED()], ctx({ complete: false }));
  assert.equal(summary.flaggedMissing, 0);
  assert.equal(rows.find((r) => r.id === 'm2'), undefined);
});

test('reappearing in the price list clears the not-in-list flag', () => {
  const existing = [{ id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE',
    grade: 'A', wearRating: '3C', wearDoubleRubs: 50000, measure: 55, measureUnit: 'in',
    price: 73, priceUnit: 'yard', composition: 'COTTON 80%, POLYESTER 20%',
    colors: [], notInPricelistAt: 500, createdAt: 1, updatedAt: 1 }];
  const { rows, summary } = mergePriceList(existing, [PARSED()], ctx({ complete: true }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].notInPricelistAt, null);
  assert.equal(summary.restored, 1);
});
