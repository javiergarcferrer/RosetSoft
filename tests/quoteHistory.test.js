/**
 * Tests for src/lib/quoteHistory.js — the pure pieces of the quote
 * workspace undo/redo: the bounded stack push and the line-restore diff.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { boundedPush, diffLinesForRestore } from '../src/lib/quoteHistory.js';

/* ------------------------------- boundedPush -------------------------- */

test('boundedPush appends and preserves order', () => {
  assert.deepEqual(boundedPush([1, 2], 3, 10), [1, 2, 3]);
});

test('boundedPush drops the oldest entries past the limit', () => {
  // Limit 3: pushing onto a full stack evicts from the front.
  assert.deepEqual(boundedPush([1, 2, 3], 4, 3), [2, 3, 4]);
});

test('boundedPush does not mutate the input stack', () => {
  const original = [1, 2];
  const result = boundedPush(original, 3, 10);
  assert.deepEqual(original, [1, 2]);
  assert.notEqual(result, original);
});

/* --------------------------- diffLinesForRestore ---------------------- */

test('restore deletes lines added since the snapshot', () => {
  // Snapshot had a,b; the user later added c. Undo must remove c.
  const current = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const target = [{ id: 'a' }, { id: 'b' }];
  const { toDelete, toPut } = diffLinesForRestore(current, target);
  assert.deepEqual(toDelete, ['c']);
  assert.equal(toPut, target); // full upsert of the snapshot rows
});

test('restore re-creates a line removed since the snapshot', () => {
  // Snapshot had a,b; the user deleted b. Undo must put b back (and
  // delete nothing, since b is simply missing from current).
  const current = [{ id: 'a' }];
  const target = [{ id: 'a' }, { id: 'b' }];
  const { toDelete, toPut } = diffLinesForRestore(current, target);
  assert.deepEqual(toDelete, []);
  assert.deepEqual(toPut.map((l) => l.id), ['a', 'b']);
});

test('restore with identical sets deletes nothing and upserts all', () => {
  const current = [{ id: 'a' }, { id: 'b' }];
  const target = [{ id: 'a' }, { id: 'b' }];
  const { toDelete, toPut } = diffLinesForRestore(current, target);
  assert.deepEqual(toDelete, []);
  assert.equal(toPut, target);
});

test('restore handles an empty target (snapshot had no lines)', () => {
  const current = [{ id: 'a' }, { id: 'b' }];
  const { toDelete, toPut } = diffLinesForRestore(current, []);
  assert.deepEqual(toDelete.sort(), ['a', 'b']);
  assert.deepEqual(toPut, []);
});
