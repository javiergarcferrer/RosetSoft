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
// Pages 1 / 7 / 8 from the same PDF: a fabric page whose columns are shifted
// ~31pt left of page 0, the LEATHER page (Thickness + Price per SM), and the
// "OUTDOOR FABRICS" page.
const MULTI = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/materialsPdf.multipage.json'), 'utf8'));

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

test('reads ½ widths, the price column, and strips the /FR suffix', () => {
  const mats = parseMaterialsPdf(PAGE0);
  assert.equal(byName(mats, 'AMALFI').measure, 54.5);   // "54½"
  assert.equal(byName(mats, 'ARA').measure, 53.5);
  assert.equal(byName(mats, 'AMALFI').price, 101);
  // "APPA/FR" in the PDF is stored as "APPA" — the /FR suffix is dropped.
  assert.equal(byName(mats, 'APPA').price, 330);
  assert.equal(byName(mats, 'APPA/FR'), undefined);
  assert.ok(mats.every((m) => !/\/FR$/i.test(m.name)), 'no name keeps a /FR suffix');
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

test('resolves columns per page: shifted fabrics (BYRAM), leather, and outdoor', () => {
  const mats = parseMaterialsPdf(MULTI);
  const find = (n) => mats.find((m) => m.name === n);

  // Page 1 columns are shifted ~31pt left of page 0 — BYRAM (grade P at x≈126,
  // name at x≈56) was being dropped by the old fixed bands. And "/FR" is gone.
  const byram = find('BYRAM');
  assert.ok(byram, 'BYRAM parsed despite the shifted columns');
  assert.equal(byram.grade, 'P');
  assert.equal(byram.price, 564);
  assert.equal(byram.measure, 55);
  assert.equal(byram.category, 'fabric');
  assert.ok(byram.composition.startsWith('MOHAIR'));

  // Page 7: LEATHER table uses "Thickness" + "Price per SM"; grades run U–X.
  const diva = find('DIVA');
  assert.ok(diva, 'leather row parsed');
  assert.equal(diva.category, 'leather');
  assert.equal(diva.grade, 'V');
  assert.equal(diva.measure, 12);
  assert.equal(diva.measureUnit, 'mm');
  assert.equal(diva.price, 291);
  assert.equal(diva.priceUnit, 'sm');
  assert.equal(find('KYOTO').grade, 'X'); // U–X grades no longer dropped

  // Page 8: "OUTDOOR FABRICS" sidebar ⇒ outdoor category.
  const elios = find('ELIOS SLING');
  assert.equal(elios.category, 'outdoor');
  assert.equal(elios.measure, 70.5); // "70½"

  assert.ok(mats.every((m) => !/\/FR$/i.test(m.name)), 'no /FR suffix survives');
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

// Identity is (category, name) — matching the DB's
// (profile_id, category, lower(name)) unique index. Keying by name alone made
// the merge emit two rows with the same (category, name) → a duplicate-key
// crash on bulkPut. These lock in the fix.
const dupKeys = (rows) => {
  const keys = rows.map((r) => `${r.category} ${r.name.toLowerCase()}`);
  return keys.length - new Set(keys).size; // 0 ⇒ no collisions
};

test('same name across categories consolidates to one row (not flagged)', () => {
  const existing = [
    { id: 'rf', profileId: 'team', category: 'fabric', name: 'ROMA', grade: 'F',
      colors: [{ name: 'x', code: '1', imageId: 'photo' }], createdAt: 1, updatedAt: 1 },
    { id: 'rl', profileId: 'team', category: 'leather', name: 'ROMA', grade: 'C', colors: [], createdAt: 1, updatedAt: 1 },
    { id: 'o', profileId: 'team', category: 'fabric', name: 'OTHER', colors: [], createdAt: 1, updatedAt: 1 },
  ];
  // Matching is by NAME, so the two ROMA rows are the same fabric → consolidated.
  const { rows, deleteIds } = mergePriceList(existing, [PARSED({ name: 'ROMA', category: 'fabric', grade: 'A' })], ctx({ complete: true }));
  assert.equal(dupKeys(rows), 0);
  assert.deepEqual(deleteIds, ['rl']);                 // duplicate ROMA folded in + removed
  const rf = rows.find((r) => r.id === 'rf');
  assert.equal(rf.grade, 'A');                          // kept row, updated from the PDF
  assert.equal(rf.notInPricelistAt, null);             // NOT wrongly flagged
  assert.deepEqual(rf.colors, [{ name: 'x', code: '1', imageId: 'photo' }]); // colors kept
  assert.equal(rows.find((r) => r.id === 'o').notInPricelistAt, 1000); // a genuinely-absent one is flagged
});

test('PDF category MOVES the existing row instead of stranding it (the ELIOS/GAYAC bug)', () => {
  const existing = [{ id: 'g', profileId: 'team', category: 'fabric', name: 'GAYAC', grade: 'X',
    colors: [{ name: 'c', code: '9', imageId: 'p' }], createdAt: 1, updatedAt: 1 }];
  // Website typed GAYAC "fabric"; the PDF lists it under OUTDOOR.
  const { rows, deleteIds, summary } = mergePriceList(existing, [PARSED({ name: 'GAYAC', category: 'outdoor', grade: 'D' })], ctx({ complete: true }));
  assert.equal(dupKeys(rows), 0);
  assert.deepEqual(deleteIds, []);
  assert.equal(summary.newMaterials, 0);               // no duplicate created
  assert.equal(summary.flaggedMissing, 0);             // old row NOT stranded "no en lista"
  const g = rows.find((r) => r.id === 'g');
  assert.equal(g.category, 'outdoor');                 // moved to the PDF's category
  assert.equal(g.grade, 'D');
  assert.deepEqual(g.colors, [{ name: 'c', code: '9', imageId: 'p' }]); // colors kept
});

test('consolidates an /FR duplicate into the clean row (merges colors, deletes the dup)', () => {
  const existing = [
    { id: 'clean', profileId: 'team', category: 'fabric', name: 'APPA', grade: 'X',
      colors: [{ name: 'ANIS', code: '855', imageId: 'photo' }], createdAt: 1, updatedAt: 1 },
    { id: 'fr', profileId: 'team', category: 'fabric', name: 'APPA/FR', grade: null,
      colors: [{ name: 'BLEU', code: '900' }], notInPricelistAt: 500, createdAt: 1, updatedAt: 1 },
  ];
  const { rows, deleteIds, summary } = mergePriceList(
    existing, [PARSED({ name: 'APPA', grade: 'I', price: 330 })], ctx({ complete: true }),
  );
  assert.deepEqual(deleteIds, ['fr']);     // the /FR dup is removed
  assert.equal(summary.consolidated, 1);
  assert.equal(summary.flaggedMissing, 0); // neither row wrongly flagged "no en lista"
  const appa = rows.find((r) => r.id === 'clean');
  assert.equal(appa.name, 'APPA');
  assert.equal(appa.grade, 'I');           // PDF spec applied
  assert.equal(appa.price, 330);
  assert.deepEqual(appa.colors.map((c) => c.code).sort(), ['855', '900']); // colors merged
  assert.equal(appa.colors.find((c) => c.code === '855').imageId, 'photo');
  assert.ok(rows.every((r) => !/\/FR$/i.test(r.name)));
});

test('a lone /FR row is renamed to the clean name — not flagged "no en lista" (the reported bug)', () => {
  const existing = [{ id: 'fr', profileId: 'team', category: 'fabric', name: 'ARDA/FR', grade: 'X',
    colors: [{ name: 'X', code: '1', imageId: 'p' }], createdAt: 1, updatedAt: 1 }];
  const { rows, deleteIds, summary } = mergePriceList(
    existing, [PARSED({ name: 'ARDA', grade: 'I' })], ctx({ complete: true }),
  );
  assert.deepEqual(deleteIds, []);
  assert.equal(summary.flaggedMissing, 0);
  const r = rows.find((x) => x.id === 'fr');
  assert.equal(r.name, 'ARDA');            // /FR dropped, same row (id preserved)
  assert.equal(r.grade, 'I');
  assert.deepEqual(r.colors, [{ name: 'X', code: '1', imageId: 'p' }]); // colors kept
});
