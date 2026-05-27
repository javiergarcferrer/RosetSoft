/**
 * Tests for src/lib/quoteGroups.js (group-level optional state + alternative
 * selection semantics) and the allowNone behavior added to
 * selectedAlternative / alternativeSubtotal in src/lib/pricing.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupById,
  isGroupOptional,
  selectedCount,
  desiredSelectedId,
} from '../src/lib/quoteGroups.js';
import { selectedAlternative, alternativeSubtotal } from '../src/lib/pricing.js';

const GROUPS = [
  { id: 'g1', quoteId: 'q', type: 'set', isOptional: true },
  { id: 'g2', quoteId: 'q', type: 'alternative', isOptional: false },
];

/* ------------------------------ lookups ------------------------------ */

test('groupById finds the row or returns undefined', () => {
  assert.equal(groupById(GROUPS, 'g1')?.type, 'set');
  assert.equal(groupById(GROUPS, 'nope'), undefined);
  assert.equal(groupById(GROUPS, null), undefined);
});

test('isGroupOptional reads the flag; absent row ⇒ false', () => {
  assert.equal(isGroupOptional(GROUPS, 'g1'), true);
  assert.equal(isGroupOptional(GROUPS, 'g2'), false);
  assert.equal(isGroupOptional(GROUPS, 'missing'), false);
});

/* ------------------------------ selection semantics ------------------------------ */

const members = [
  { id: 'a', alternativeGroup: 'g', isSelectedAlternative: true },
  { id: 'b', alternativeGroup: 'g', isSelectedAlternative: false },
  { id: 'c', alternativeGroup: 'g', isSelectedAlternative: false },
];

test('mandatory group: clicking always selects the clicked line', () => {
  assert.equal(desiredSelectedId(members, 'b', false), 'b');
  assert.equal(desiredSelectedId(members, 'a', false), 'a'); // re-click stays selected
});

test('optional group: clicking the selected line deselects to none', () => {
  assert.equal(desiredSelectedId(members, 'a', true), null); // a was selected → none
  assert.equal(desiredSelectedId(members, 'b', true), 'b');  // pick a different one
});

test('selectedCount counts selected members of a group', () => {
  assert.equal(selectedCount(members, 'g'), 1);
  const none = members.map((m) => ({ ...m, isSelectedAlternative: false }));
  assert.equal(selectedCount(none, 'g'), 0);
});

/* ------------------------------ pricing: allowNone ------------------------------ */

const altLines = [
  { id: 'a', alternativeGroup: 'g', isSelectedAlternative: false, kind: 'item', qty: 1, unitPrice: 100 },
  { id: 'b', alternativeGroup: 'g', isSelectedAlternative: false, kind: 'item', qty: 1, unitPrice: 200 },
];

test('mandatory group with zero selected falls back to the first member', () => {
  assert.equal(selectedAlternative(altLines, 'g')?.id, 'a');
  assert.equal(alternativeSubtotal(altLines, 'g'), 100);
});

test('optional group with zero selected contributes nothing', () => {
  assert.equal(selectedAlternative(altLines, 'g', { allowNone: true }), null);
  assert.equal(alternativeSubtotal(altLines, 'g', { allowNone: true }), 0);
});

test('a selected member prices normally regardless of allowNone', () => {
  const picked = [
    { ...altLines[0], isSelectedAlternative: true },
    altLines[1],
  ];
  assert.equal(alternativeSubtotal(picked, 'g', { allowNone: true }), 100);
  assert.equal(alternativeSubtotal(picked, 'g'), 100);
});
