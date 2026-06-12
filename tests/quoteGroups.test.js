/**
 * Tests for the quote-group invariants (src/lib/quoteGroups.ts) — the pure
 * patch-writers behind Alternativas (pick-one) and Conjuntos (take-all sets).
 * Data-integrity: these flags drive isPricedLine, so a broken invariant
 * silently prices the wrong lines.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isGroupOptional, selectAlternativePatches, healAlternativeOnRemove, healSetOnRemove,
} from '../src/lib/quoteGroups.js';

test('selectAlternativePatches: exactly one sibling ends selected; untouched rows get no patch', () => {
  const siblings = [
    { id: 'a', isSelectedAlternative: true },
    { id: 'b', isSelectedAlternative: false },
    { id: 'c', isSelectedAlternative: false },
  ];
  // Pick b → a clears, b sets, c (already false) untouched.
  assert.deepEqual(selectAlternativePatches(siblings, 'b'), [
    { id: 'a', patch: { isSelectedAlternative: false } },
    { id: 'b', patch: { isSelectedAlternative: true } },
  ]);
  // Re-pick the already-selected → no writes at all.
  assert.deepEqual(selectAlternativePatches(siblings, 'a'), []);
});

test('healAlternativeOnRemove: a menu of one collapses; a removed pick re-selects a survivor', () => {
  // 1 survivor → promoted to standalone (group + selection cleared).
  assert.deepEqual(healAlternativeOnRemove([{ id: 'x' }], false), [
    { id: 'x', patch: { alternativeGroup: null, isSelectedAlternative: false } },
  ]);
  // >1 survivors and the removed line WAS the pick → first survivor selected.
  assert.deepEqual(healAlternativeOnRemove([{ id: 'x' }, { id: 'y' }], true), [
    { id: 'x', patch: { isSelectedAlternative: true } },
  ]);
  // >1 survivors, pick intact → nothing to heal.
  assert.deepEqual(healAlternativeOnRemove([{ id: 'x' }, { id: 'y' }], false), []);
});

test('healSetOnRemove: a lone set member goes standalone (optional cleared) and the group row dies', () => {
  assert.deepEqual(healSetOnRemove([{ id: 'x' }]), {
    linePatches: [{ id: 'x', patch: { setGroup: null, isOptional: false } }],
    deleteGroup: true,
  });
  assert.deepEqual(healSetOnRemove([{ id: 'x' }, { id: 'y' }]), { linePatches: [], deleteGroup: false });
});

test('isGroupOptional: absent group row ⇒ not optional', () => {
  const groups = [{ id: 'g1', isOptional: true }, { id: 'g2', isOptional: false }];
  assert.equal(isGroupOptional(groups, 'g1'), true);
  assert.equal(isGroupOptional(groups, 'g2'), false);
  assert.equal(isGroupOptional(groups, 'missing'), false);
  assert.equal(isGroupOptional(null, 'g1'), false);
});
