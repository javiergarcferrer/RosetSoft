/**
 * Tests for src/lib/lrCatalog.ts — mapping a Ligne Roset product page's
 * patterns into our catalog and merging them non-destructively into the
 * existing materials.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  lrTypeToCategory,
  normalizeName,
  cleanNotes,
  mergeCatalog,
} from '../src/lib/lrCatalog.js';

/* ------------------------------ type → category ----------------------------- */

test('lrTypeToCategory — leather/outdoor/fabric buckets', () => {
  assert.equal(lrTypeToCategory('Leather'), 'leather');
  assert.equal(lrTypeToCategory('Outdoor fabrics'), 'outdoor');
  // Everything else (the many fabric sub-types) collapses to fabric.
  for (const t of ['Fabrics', 'Microfibres', 'Microfibers', 'Velvets', 'Wools', 'Chenilles', 'Fabrics with effect threads', '"Technical" fabrics + coated + jersey']) {
    assert.equal(lrTypeToCategory(t), 'fabric', t);
  }
  assert.equal(lrTypeToCategory(null), 'fabric');
});

/* ------------------------------ normalizeName ------------------------------- */

test('normalizeName — upper, trim, collapse whitespace', () => {
  assert.equal(normalizeName('  alcantara - a '), 'ALCANTARA - A');
  assert.equal(normalizeName('Steelcut  Trio 3/FR'), 'STEELCUT TRIO 3/FR');
  assert.equal(normalizeName(null), '');
});

/* -------------------------------- cleanNotes -------------------------------- */

test('cleanNotes — keeps real warnings, drops trivial SWATCH markers', () => {
  assert.equal(cleanNotes(' SWATCH A'), null);
  assert.equal(cleanNotes('SWATCH B'), null);
  assert.equal(cleanNotes(''), null);
  assert.equal(cleanNotes(null), null);
  assert.equal(
    cleanNotes('THIS FABRIC IS NOT TB117-2013 APPROVED   AND CANNOT BE USED…'),
    'THIS FABRIC IS NOT TB117-2013 APPROVED AND CANNOT BE USED…',
  );
});

/* -------------------------------- mergeCatalog ------------------------------ */

// Deterministic id factory so assertions are stable.
function ctx() {
  let n = 0;
  return { profileId: 'team', now: 1000, newId: () => `new-${++n}` };
}

test('adds a brand-new material with its colors and derived fields', () => {
  const { rows, summary } = mergeCatalog(
    [],
    [{
      name: 'ACATE',
      type: 'Fabrics',
      composition: 'COTTON 80%, POLYESTER 20%',
      remark: ' SWATCH A',
      colors: [{ code: '855', name: 'ANIS' }, { code: '857', name: 'NOIR' }],
    }],
    ctx(),
  );
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.id, 'new-1');
  assert.equal(m.profileId, 'team');
  assert.equal(m.category, 'fabric');
  assert.equal(m.name, 'ACATE');
  assert.equal(m.composition, 'COTTON 80%, POLYESTER 20%');
  assert.equal(m.notes, null);            // trivial "SWATCH A" dropped
  assert.equal(m.grade, null);            // never invented
  assert.equal(m.price, null);
  assert.equal(m.measureUnit, 'in');      // fabric default
  assert.equal(m.priceUnit, 'yard');
  assert.deepEqual(m.colors, [
    { name: 'ANIS', code: '855' },
    { name: 'NOIR', code: '857' },
  ]);
  assert.deepEqual(summary, {
    newMaterials: 1, updatedMaterials: 0, unchangedMaterials: 0,
    newColors: 2, namedColors: 0, filledComposition: 0, filledNotes: 0,
  });
});

test('new leather material gets mm / sm units', () => {
  const { rows } = mergeCatalog(
    [],
    [{ name: 'DIVA', type: 'Leather', composition: null, remark: null, colors: [{ code: '3807', name: 'TAUPE' }] }],
    ctx(),
  );
  assert.equal(rows[0].category, 'leather');
  assert.equal(rows[0].measureUnit, 'mm');
  assert.equal(rows[0].priceUnit, 'sm');
});

test('enriches an existing material: adds missing colors, keeps grade/price/photos', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'ALCANTARA - A',
    grade: 'S', price: 363, priceUnit: 'yard', composition: 'POLYESTER 68%, …',
    notes: null,
    colors: [
      { name: 'ALMOND', code: '4479', imageId: 'photo-1' }, // dealer photo must survive
      { name: '', code: '4500' },                           // has code, never named
    ],
    createdAt: 1, updatedAt: 1,
  }];
  const { rows, summary } = mergeCatalog(
    existing,
    [{
      name: 'alcantara - a',                  // matches case-insensitively
      type: 'Microfibres',
      composition: 'IGNORED — ours wins',     // existing composition is set → not overwritten
      remark: ' SWATCH A',
      colors: [
        { code: '4479', name: 'ALMOND' },     // already present, named → no-op
        { code: '4500', name: 'AMBER GLOW' }, // present but unnamed → fill name
        { code: '4522', name: 'ANTHRACITE' }, // new → append
      ],
    }],
    ctx(),
  );
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.id, 'm1');                   // same identity, not a new row
  assert.equal(m.grade, 'S');                 // untouched
  assert.equal(m.price, 363);                 // untouched
  assert.equal(m.composition, 'POLYESTER 68%, …'); // ours kept
  assert.equal(m.updatedAt, 1000);
  assert.deepEqual(m.colors, [
    { name: 'ALMOND', code: '4479', imageId: 'photo-1' }, // photo preserved
    { name: 'AMBER GLOW', code: '4500' },                 // name backfilled
    { name: 'ANTHRACITE', code: '4522' },                 // appended
  ]);
  assert.equal(summary.updatedMaterials, 1);
  assert.equal(summary.newColors, 1);
  assert.equal(summary.namedColors, 1);
  assert.equal(summary.filledComposition, 0);
});

test('backfills composition and notes only when ours is empty', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'CLOUD',
    grade: null, composition: '', notes: '', colors: [], createdAt: 1, updatedAt: 1,
  }];
  const { rows, summary } = mergeCatalog(
    existing,
    [{
      name: 'CLOUD', type: 'Velvets',
      composition: '56% ACRYLIC, 44% POLYESTER',
      remark: 'The moiré effect is a natural characteristic of this fabric.',
      colors: [],
    }],
    ctx(),
  );
  assert.equal(rows[0].composition, '56% ACRYLIC, 44% POLYESTER');
  assert.equal(rows[0].notes, 'The moiré effect is a natural characteristic of this fabric.');
  assert.equal(summary.filledComposition, 1);
  assert.equal(summary.filledNotes, 1);
});

test('no-op when nothing changes → not in rows, counted as unchanged', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE',
    grade: 'A', composition: 'COTTON 80%, POLYESTER 20%', notes: null,
    colors: [{ name: 'ANIS', code: '855' }], createdAt: 1, updatedAt: 1,
  }];
  const patterns = [{
    name: 'ACATE', type: 'Fabrics', composition: 'COTTON 80%, POLYESTER 20%',
    remark: ' SWATCH A', colors: [{ code: '855', name: 'ANIS' }],
  }];
  const { rows, summary } = mergeCatalog(existing, patterns, ctx());
  assert.equal(rows.length, 0);
  assert.equal(summary.unchangedMaterials, 1);
  assert.equal(summary.updatedMaterials, 0);
});

test('merge is idempotent — a second run over applied rows changes nothing', () => {
  const patterns = [{
    name: 'ACATE', type: 'Fabrics', composition: 'COTTON 80%, POLYESTER 20%',
    remark: 'Treated against stains (TEFLON).',
    colors: [{ code: '855', name: 'ANIS' }, { code: '857', name: 'NOIR' }],
  }];
  const first = mergeCatalog([], patterns, ctx());
  const second = mergeCatalog(first.rows, patterns, ctx());
  assert.equal(second.rows.length, 0);
  assert.equal(second.summary.unchangedMaterials, 1);
});

test('dedupes repeated color codes within a pattern (first non-empty name wins)', () => {
  const { rows } = mergeCatalog(
    [],
    [{
      name: 'X', type: 'Fabrics', composition: null, remark: null,
      colors: [
        { code: '100', name: '' },
        { code: '100', name: 'RED' },   // same code → folded in, supplies the name
        { code: '200', name: 'BLUE' },
      ],
    }],
    ctx(),
  );
  assert.deepEqual(rows[0].colors, [
    { name: 'RED', code: '100' },
    { name: 'BLUE', code: '200' },
  ]);
});
