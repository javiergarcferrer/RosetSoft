/**
 * Tests for src/lib/quoteGroups.js — group-level optional state for Conjuntos.
 * (Alternativas are never optional: building an alternative means at least one
 * option will be used, so it always counts toward the total.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupById,
  isGroupOptional,
  selectAlternativePatches,
  healAlternativeOnRemove,
  healSetOnRemove,
} from '../src/lib/quoteGroups.js';

const GROUPS = [
  { id: 'g1', quoteId: 'q', type: 'set', isOptional: true },
  { id: 'g2', quoteId: 'q', type: 'set', isOptional: false },
];

test('groupById finds the row or returns undefined', () => {
  assert.equal(groupById(GROUPS, 'g1')?.type, 'set');
  assert.equal(groupById(GROUPS, 'nope'), undefined);
  assert.equal(groupById(GROUPS, null), undefined);
});

test('isGroupOptional reads the flag; absent row ⇒ false', () => {
  assert.equal(isGroupOptional(GROUPS, 'g1'), true);
  assert.equal(isGroupOptional(GROUPS, 'g2'), false);
  assert.equal(isGroupOptional(GROUPS, 'missing'), false);
  assert.equal(isGroupOptional([], 'g1'), false);
  assert.equal(isGroupOptional(null, 'g1'), false);
});

/* ----------------------- selectAlternativePatches --------------------- */

test('selectAlternativePatches makes exactly the picked sibling selected', () => {
  const sibs = [
    { id: 'a', isSelectedAlternative: true },
    { id: 'b', isSelectedAlternative: false },
    { id: 'c', isSelectedAlternative: false },
  ];
  // Pick b: a flips off, b flips on, c already false → only a + b change.
  assert.deepEqual(selectAlternativePatches(sibs, 'b'), [
    { id: 'a', patch: { isSelectedAlternative: false } },
    { id: 'b', patch: { isSelectedAlternative: true } },
  ]);
});

test('selectAlternativePatches emits nothing when the pick is already correct', () => {
  const sibs = [
    { id: 'a', isSelectedAlternative: true },
    { id: 'b', isSelectedAlternative: false },
  ];
  assert.deepEqual(selectAlternativePatches(sibs, 'a'), []);
  assert.deepEqual(selectAlternativePatches([], 'a'), []);
});

/* ----------------------- healAlternativeOnRemove ---------------------- */

test('healAlternativeOnRemove: a lone survivor is promoted to standalone', () => {
  assert.deepEqual(
    healAlternativeOnRemove([{ id: 's' }], false),
    [{ id: 's', patch: { alternativeGroup: null, isSelectedAlternative: false } }],
  );
});

test('healAlternativeOnRemove: removing the SELECTED member promotes the first survivor', () => {
  assert.deepEqual(
    healAlternativeOnRemove([{ id: 'x' }, { id: 'y' }], true),
    [{ id: 'x', patch: { isSelectedAlternative: true } }],
  );
});

test('healAlternativeOnRemove: removing a non-selected member of a still-valid group is a no-op', () => {
  assert.deepEqual(healAlternativeOnRemove([{ id: 'x' }, { id: 'y' }], false), []);
  assert.deepEqual(healAlternativeOnRemove([], false), []);
});

/* ----------------------- healSetOnRemove ------------------------------ */

test('healSetOnRemove: a set of one heals to standalone + deletes the group', () => {
  assert.deepEqual(healSetOnRemove([{ id: 's' }]), {
    linePatches: [{ id: 's', patch: { setGroup: null, isOptional: false } }],
    deleteGroup: true,
  });
});

test('healSetOnRemove: a set still ≥2 members is left intact', () => {
  assert.deepEqual(healSetOnRemove([{ id: 'a' }, { id: 'b' }]), { linePatches: [], deleteGroup: false });
  assert.deepEqual(healSetOnRemove([]), { linePatches: [], deleteGroup: false });
});
