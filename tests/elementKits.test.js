/**
 * Tests for src/lib/elementKits.js — the complete-element ↔ separate-parts map
 * for modular models, plus explode / recompose. Numbers are the real EXCLUSIF
 * Right-Arm Loveseat at Grade I, from quote #1016:
 *   complete 10002953I = 8050
 *   frame    10003013I = 6430 · back 17220220I = 1235 · scatter 17220000I = 630
 *   → parts sum 8295, so separating costs +245 over the complete element.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { groupFamilies, productForGrade } from '../src/lib/catalog.js';
import {
  kitForReference,
  hasKit,
  gradeOf,
  separationDeltaUsd,
  buildPartComponents,
  buildCompleteComponent,
  explodeComponentInList,
  recomposeKitGroupInList,
} from '../src/lib/elementKits.js';

/* A two-grade (A, I) catalog so every family reads as `graded`. */
const PRODUCTS = [
  { reference: '10002953A', name: 'EXCLUSIF RIGHT-ARM LOVESEAT', family: 'SEATS', priceUsd: 6405 },
  { reference: '10002953I', name: 'EXCLUSIF RIGHT-ARM LOVESEAT', family: 'SEATS', priceUsd: 8050 },
  { reference: '10003013A', name: 'EXCLUSIF RIGHT-ARM LOVESEAT FRAME', family: 'SEATS', priceUsd: 5225 },
  { reference: '10003013I', name: 'EXCLUSIF RIGHT-ARM LOVESEAT FRAME', family: 'SEATS', priceUsd: 6430 },
  { reference: '17220220A', name: 'EXCLUSIF 1 BACK CUSHION', family: 'SEATS', priceUsd: 845 },
  { reference: '17220220I', name: 'EXCLUSIF 1 BACK CUSHION', family: 'SEATS', priceUsd: 1235 },
  { reference: '17220000A', name: 'EXCLUSIF CUSHION 22 1/2', family: 'SEATS', priceUsd: 425 },
  { reference: '17220000I', name: 'EXCLUSIF CUSHION 22 1/2', family: 'SEATS', priceUsd: 630 },
];

const FAM_BY_ROOT = new Map(groupFamilies(PRODUCTS).map((f) => [f.root, f]));
const resolve = (root, grade) => {
  const fam = FAM_BY_ROOT.get(root);
  return fam ? productForGrade(fam, grade) : null;
};

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

const COMPLETE = {
  id: 'c1',
  name: 'EXCLUSIF RIGHT-ARM LOVESEAT',
  reference: '10002953I',
  subtype: 'Grade I — CODA/FR · CREME/NOIR (#4701)',
  swatchImageId: 'sw1',
  qty: 1,
  unitPrice: 8050,
};

/* ------------------------------ kit lookup ------------------------------ */

test('kitForReference keys on the SKU root, tolerating the grade letter', () => {
  assert.equal(kitForReference('10002953I')?.completeRoot, '10002953');
  // A stale grade letter still resolves (root is what matters).
  assert.equal(kitForReference('10002953A')?.completeRoot, '10002953');
  assert.deepEqual(kitForReference('17220600X')?.partRoots, ['17220610', '17220620', '17220000']);
  assert.equal(kitForReference('99999999A'), null);
  assert.equal(hasKit('10002953I'), true);
  assert.equal(hasKit(''), false);
});

/* ------------------------------- gradeOf ------------------------------- */

test('gradeOf prefers the subtype grade, falls back to the reference letter', () => {
  // Subtype wins over a stale reference letter (the #1016 case).
  assert.equal(gradeOf({ subtype: 'Grade I — CODA', reference: '10002953A' }), 'I');
  assert.equal(gradeOf({ subtype: '', reference: '10002953I' }), 'I');
  assert.equal(gradeOf({ subtype: '', reference: '' }), '');
});

/* --------------------------- separation delta --------------------------- */

test('separationDeltaUsd is parts − complete (+245 at Grade I)', () => {
  const complete = resolve('10002953', 'I');
  const parts = ['10003013', '17220220', '17220000'].map((r) => resolve(r, 'I'));
  assert.equal(separationDeltaUsd(complete, parts), 245);
});

/* --------------------------- build part pieces --------------------------- */

test('buildPartComponents itemizes at the current grade, inheriting material', () => {
  const newId = ids();
  const parts = buildPartComponents(COMPLETE, kitForReference('10002953I'), resolve, newId);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.reference), ['10003013I', '17220220I', '17220000I']);
  assert.deepEqual(parts.map((p) => p.unitPrice), [6430, 1235, 630]);
  // one shared kitGroup; every part remembers the complete root.
  assert.equal(new Set(parts.map((p) => p.kitGroup)).size, 1);
  parts.forEach((p) => assert.equal(p.kitCompleteRoot, '10002953'));
  // material (subtype + swatch) carried from the complete piece.
  parts.forEach((p) => {
    assert.equal(p.subtype, COMPLETE.subtype);
    assert.equal(p.swatchImageId, 'sw1');
    assert.equal(p.qty, 1);
  });
});

test('buildPartComponents aborts (null) when a part has no price at the grade', () => {
  // Grade Z is absent from the fixture catalog → a part can't be priced.
  const parts = buildPartComponents(
    { ...COMPLETE, subtype: 'Grade Z' },
    kitForReference('10002953I'),
    resolve,
    ids(),
  );
  assert.equal(parts, null);
});

/* ----------------------------- list explode ----------------------------- */

test('explodeComponentInList splices the parts in at the piece index', () => {
  const list = [COMPLETE, { id: 'other', reference: 'ZZZZ0000', name: 'Side table' }];
  const out = explodeComponentInList(list, 'c1', resolve, ids());
  assert.equal(out.length, 4);
  assert.deepEqual(out.slice(0, 3).map((p) => p.reference), ['10003013I', '17220220I', '17220000I']);
  assert.equal(out[3].id, 'other');
});

test('explodeComponentInList returns null when the piece has no kit', () => {
  const out = explodeComponentInList([{ id: 'x', reference: '99999999A' }], 'x', resolve, ids());
  assert.equal(out, null);
});

/* ------------------------- recompose round-trip ------------------------- */

test('recompose folds a kit group back into the complete element', () => {
  const exploded = explodeComponentInList([COMPLETE, { id: 'other', name: 'Side table' }], 'c1', resolve, ids());
  const kitGroup = exploded[0].kitGroup;
  const out = recomposeKitGroupInList(exploded, kitGroup, resolve, ids());
  assert.equal(out.length, 2);
  assert.equal(out[0].reference, '10002953I');
  assert.equal(out[0].unitPrice, 8050);
  assert.equal(out[0].kitGroup, undefined); // a recomposed complete carries no kit bookkeeping
  assert.equal(out[1].id, 'other');
});

test('buildCompleteComponent needs the remembered complete root', () => {
  // A part with no kitCompleteRoot can't be recomposed.
  assert.equal(buildCompleteComponent([{ id: 'p', subtype: 'Grade I' }], resolve, ids()), null);
});
