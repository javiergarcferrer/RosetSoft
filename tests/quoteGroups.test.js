/**
 * Tests for src/lib/quoteGroups.js — group-level optional state for Conjuntos.
 * (Alternativas are never optional: building an alternative means at least one
 * option will be used, so it always counts toward the total.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { groupById, isGroupOptional } from '../src/lib/quoteGroups.js';

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
