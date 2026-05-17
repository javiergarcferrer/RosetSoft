/**
 * Tests for computeNextSequenceNumber — the pure-function core of the
 * sequence-number rule. The I/O wrapper (nextSequenceNumber) is covered
 * implicitly by the app's smoke runs; this file pins down the rule.
 *
 * Rule:
 *   • Empty table (currentMax = null) → returns `start`.
 *   • Non-empty → returns Number(currentMax) + 1.
 *
 * The "fill holes only when you delete the top" behavior is a property
 * of this rule plus the calling pattern (always read max immediately
 * before insert): delete the top row and max drops, so the next insert
 * reuses that number; delete a middle row and max is unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeNextSequenceNumber } from '../src/db/database.js';

test('empty collection starts at the provided start value', () => {
  assert.equal(computeNextSequenceNumber(null, 1001), 1001);
  assert.equal(computeNextSequenceNumber(null, 101), 101);
  assert.equal(computeNextSequenceNumber(undefined, 101), 101);
});

test('non-empty collection returns current max + 1', () => {
  assert.equal(computeNextSequenceNumber(1003, 1001), 1004);
  assert.equal(computeNextSequenceNumber(150, 101), 151);
});

test('coerces stringified bigints (Supabase quirk) before adding', () => {
  // Without Number() coercion the result would be "10031" instead of 1004.
  assert.equal(computeNextSequenceNumber('1003', 1001), 1004);
});

test('deleting the highest-numbered row makes its number available again', () => {
  // Scenario: {#1001, #1002, #1003} → user deletes #1003 → max drops to 1002
  // → next create reads max=1002 and reuses 1003.
  const beforeDelete = computeNextSequenceNumber(1003, 1001);
  assert.equal(beforeDelete, 1004);

  const afterDeletingTop = computeNextSequenceNumber(1002, 1001);
  assert.equal(afterDeletingTop, 1003); // reuses the freed number
});

test('deleting a middle row leaves the hole; next still goes above the top', () => {
  // Scenario: {#1001, #1002, #1003, #1004, #1005} → user deletes #1003.
  // max is still 1005, so next is 1006. The user's words: "si borro la #3
  // y voy por la #5, la siguiente no puede tener el número 3".
  assert.equal(computeNextSequenceNumber(1005, 1001), 1006);
});

test('start value is honored when every row has been deleted', () => {
  // Scenario: user creates and deletes everything → table is empty again →
  // next create starts fresh at the configured floor, not at 1.
  assert.equal(computeNextSequenceNumber(null, 1001), 1001);
});
