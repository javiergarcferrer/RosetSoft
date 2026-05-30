/**
 * Tests for src/lib/lrCatalog.ts — mapping Ligne Roset patterns into our
 * catalog with the site as source of truth: overwrite the fields the site
 * carries, preserve dealer-only data (grade/price/photos), and on a full sweep
 * flag (never delete) materials the site no longer offers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  lrTypeToCategory,
  normalizeName,
  cleanNotes,
  mergeCatalog,
  fabricKey,
} from '../src/lib/lrCatalog.js';

/* ------------------------------ type → category ----------------------------- */

test('lrTypeToCategory — leather/outdoor/fabric buckets', () => {
  assert.equal(lrTypeToCategory('Leather'), 'leather');
  assert.equal(lrTypeToCategory('Outdoor fabrics'), 'outdoor');
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

function ctx(extra) {
  let n = 0;
  return { profileId: 'team', now: 1000, newId: () => `new-${++n}`, ...extra };
}

test('adds a brand-new material with its colors and derived fields', () => {
  const { rows, summary } = mergeCatalog(
    [],
    [{
      name: 'ACATE', type: 'Fabrics', composition: 'COTTON 80%, POLYESTER 20%',
      remark: ' SWATCH A',
      colors: [{ code: '855', name: 'ANIS' }, { code: '857', name: 'NOIR' }],
    }],
    ctx(),
  );
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.id, 'new-1');
  assert.equal(m.category, 'fabric');
  assert.equal(m.name, 'ACATE');
  assert.equal(m.composition, 'COTTON 80%, POLYESTER 20%');
  assert.equal(m.notes, null);            // trivial "SWATCH A" dropped
  assert.equal(m.grade, null);            // never invented
  assert.equal(m.price, null);
  assert.equal(m.discontinuedAt, null);
  assert.equal(m.measureUnit, 'in');
  assert.equal(m.priceUnit, 'yard');
  assert.deepEqual(m.colors, [{ name: 'ANIS', code: '855' }, { name: 'NOIR', code: '857' }]);
  assert.equal(summary.newMaterials, 1);
  assert.equal(summary.newColors, 2);
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

test('website merge: owns colors+notes, leaves name/category/composition to the price list', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'ALCANTARA - A',
    grade: 'S', price: 363, priceUnit: 'yard', measure: 56, measureUnit: 'in',
    wearRating: '3C',
    composition: 'POLYESTER 68%, NON FIBROUS POLYURETHANE 32%', // from the PDF — kept
    notes: 'dealer scribble — site wins',
    colors: [
      { name: 'almond', code: '4479', imageId: 'photo-1' }, // dealer photo must survive
      { name: 'OLD COLOR', code: '0000' },                   // not on site → removed
    ],
    createdAt: 1, updatedAt: 1,
  }];
  const { rows, summary } = mergeCatalog(
    existing,
    [{
      name: 'ALCANTARA - A', type: 'Microfibres',
      composition: 'SITE COMPOSITION — must NOT overwrite the PDF one',
      remark: 'THIS FABRIC IS NOT TB117-2013 APPROVED.',
      colors: [
        { code: '4479', name: 'ALMOND' },     // kept, photo carried, name normalized
        { code: '4522', name: 'ANTHRACITE' }, // new
      ],
    }],
    ctx(),
  );
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.id, 'm1');
  // price-list-owned fields untouched by the website sync:
  assert.equal(m.composition, 'POLYESTER 68%, NON FIBROUS POLYURETHANE 32%'); // NOT overwritten
  assert.equal(m.grade, 'S');
  assert.equal(m.price, 363);
  assert.equal(m.measure, 56);
  assert.equal(m.wearRating, '3C');
  // website-owned fields updated:
  assert.equal(m.notes, 'THIS FABRIC IS NOT TB117-2013 APPROVED.');           // overwritten
  assert.deepEqual(m.colors, [
    { name: 'ALMOND', code: '4479', imageId: 'photo-1' },
    { name: 'ANTHRACITE', code: '4522' },
  ]);
  assert.equal(summary.updatedMaterials, 1);
  assert.equal(summary.newColors, 1);
  assert.equal(summary.removedColors, 1);
});

test('a transient empty color payload never wipes an existing color set', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE',
    composition: 'COTTON 80%, POLYESTER 20%', notes: null,
    colors: [{ name: 'ANIS', code: '855' }], createdAt: 1, updatedAt: 1,
  }];
  const { rows, summary } = mergeCatalog(
    existing,
    [{ name: 'ACATE', type: 'Fabrics', composition: 'COTTON 80%, POLYESTER 20%', remark: null, colors: [] }],
    ctx(),
  );
  // Nothing changed (colors kept, everything else equal) → no row emitted.
  assert.equal(rows.length, 0);
  assert.equal(summary.unchangedMaterials, 1);
});

test('no-op when site matches stored state → not in rows', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE',
    grade: 'A', composition: 'COTTON 80%, POLYESTER 20%', notes: null,
    colors: [{ name: 'ANIS', code: '855' }], discontinuedAt: null,
    createdAt: 1, updatedAt: 1,
  }];
  const patterns = [{
    name: 'ACATE', type: 'Fabrics', composition: 'COTTON 80%, POLYESTER 20%',
    remark: ' SWATCH A', colors: [{ code: '855', name: 'ANIS' }],
  }];
  const { rows, summary } = mergeCatalog(existing, patterns, ctx());
  assert.equal(rows.length, 0);
  assert.equal(summary.unchangedMaterials, 1);
});

test('merge is idempotent — second run over applied rows changes nothing', () => {
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

/* ------------------------------ complete sweep ------------------------------ */

test('complete sweep flags (never deletes) a material the site no longer offers', () => {
  const existing = [
    { id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE', composition: 'C', notes: null, colors: [{ name: 'ANIS', code: '855' }], createdAt: 1, updatedAt: 1 },
    { id: 'm2', profileId: 'team', category: 'fabric', name: 'CUSTOM COM', grade: 'X', price: 99, colors: [], createdAt: 1, updatedAt: 1 }, // not on site
  ];
  const patterns = [{ name: 'ACATE', type: 'Fabrics', composition: 'C', remark: null, colors: [{ code: '855', name: 'ANIS' }] }];
  const { rows, summary } = mergeCatalog(existing, patterns, ctx({ complete: true }));
  // ACATE unchanged; CUSTOM COM flagged but kept (id/grade/price intact).
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'm2');
  assert.equal(rows[0].discontinuedAt, 1000);
  assert.equal(rows[0].grade, 'X');
  assert.equal(rows[0].price, 99);
  assert.equal(summary.flaggedMissing, 1);
});

test('a partial (single-product) import never flags absent materials', () => {
  const existing = [
    { id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE', composition: 'C', notes: null, colors: [{ name: 'ANIS', code: '855' }], createdAt: 1, updatedAt: 1 },
    { id: 'm2', profileId: 'team', category: 'fabric', name: 'OTHER', colors: [], createdAt: 1, updatedAt: 1 },
  ];
  const patterns = [{ name: 'ACATE', type: 'Fabrics', composition: 'C', remark: null, colors: [{ code: '855', name: 'ANIS' }] }];
  const { rows, summary } = mergeCatalog(existing, patterns, ctx({ complete: false }));
  assert.equal(rows.length, 0);            // OTHER untouched, ACATE unchanged
  assert.equal(summary.flaggedMissing, 0);
});

test('re-appearing on the site clears the discontinued flag (restored)', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'ACATE', composition: 'C', notes: null,
    colors: [{ name: 'ANIS', code: '855' }], discontinuedAt: 500, createdAt: 1, updatedAt: 1,
  }];
  const patterns = [{ name: 'ACATE', type: 'Fabrics', composition: 'C', remark: null, colors: [{ code: '855', name: 'ANIS' }] }];
  const { rows, summary } = mergeCatalog(existing, patterns, ctx({ complete: true }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discontinuedAt, null);
  assert.equal(summary.restored, 1);
  assert.equal(summary.updatedMaterials, 1);
});

test('already-flagged + still missing stays flagged without re-emitting', () => {
  const existing = [{
    id: 'm1', profileId: 'team', category: 'fabric', name: 'GONE', colors: [],
    discontinuedAt: 500, createdAt: 1, updatedAt: 1,
  }];
  const { rows, summary } = mergeCatalog(existing, [], ctx({ complete: true }));
  assert.equal(rows.length, 0);
  assert.equal(summary.flaggedMissing, 0);
  assert.equal(summary.unchangedMaterials, 1);
});

test('keeps a dealer-set outdoor category — the site never encodes outdoor', () => {
  // ELIOS SLING is an outdoor sling, but the site types it "Fabrics". A sync
  // must overwrite its other fields without demoting it out of Outdoor.
  const existing = [{
    id: 'm1', profileId: 'team', category: 'outdoor', name: 'ELIOS SLING',
    composition: null, notes: null, colors: [{ name: 'A', code: '1' }],
    createdAt: 1, updatedAt: 1,
  }];
  const patterns = [{
    name: 'ELIOS SLING', type: 'Fabrics', composition: 'PVC', remark: null,
    colors: [{ code: '1', name: 'A' }, { code: '2', name: 'B' }],
  }];
  const { rows } = mergeCatalog(existing, patterns, ctx({ complete: true }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'outdoor'); // not demoted to 'fabric'
  assert.equal(rows[0].composition, 'PVC');  // other fields still overwritten
});

test('dedupes repeated color codes within a pattern (first non-empty name wins)', () => {
  const { rows } = mergeCatalog(
    [],
    [{
      name: 'X', type: 'Fabrics', composition: null, remark: null,
      colors: [{ code: '100', name: '' }, { code: '100', name: 'RED' }, { code: '200', name: 'BLUE' }],
    }],
    ctx(),
  );
  assert.deepEqual(rows[0].colors, [{ name: 'RED', code: '100' }, { name: 'BLUE', code: '200' }]);
});

// fabricKey — the name-matching key used by the per-model fabric restriction
// (lrModelFabrics + MaterialColorPicker). Builds on normalizeName and strips the
// "/FR" fire-retardant suffix so a model's offered "VIDAR/FR" matches the catalog
// material "VIDAR" (the catalog consolidates the two into one row).
test('fabricKey: strips the /FR suffix so offered names match catalog names', () => {
  assert.equal(fabricKey('VIDAR/FR'), fabricKey('VIDAR'));
  assert.equal(fabricKey('VIDAR / FR'), 'VIDAR');
  assert.equal(fabricKey('Steelcut Trio 3/FR'), 'STEELCUT TRIO 3');
});

test('fabricKey: folds case, accents and whitespace (inherits normalizeName)', () => {
  assert.equal(fabricKey('  Mosaïc  '), fabricKey('MOSAIC'));
});

test('fabricKey: an in-grade fabric NOT on the model is excluded by the allowlist', () => {
  // Mirror the MaterialColorPicker filter: only offered (by fabricKey) pass.
  const offered = new Set(['VIDAR/FR', 'DIVA'].map(fabricKey));
  const materials = [
    { name: 'VIDAR', grade: 'C' },   // offered (matches VIDAR/FR)
    { name: 'DIVA', grade: 'C' },    // offered
    { name: 'ALCANTARA - A', grade: 'C' }, // in-grade but NOT offered
  ];
  const visible = materials.filter((m) => offered.has(fabricKey(m.name))).map((m) => m.name);
  assert.deepEqual(visible, ['VIDAR', 'DIVA']);
});
