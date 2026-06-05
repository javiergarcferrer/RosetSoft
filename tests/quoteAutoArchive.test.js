/**
 * Tests for quotesToAutoArchive (src/lib/quoteStages.ts) — the policy behind the
 * load-time sweep that archives cold quotes: SENT to a client but not accepted
 * within the window, measured from sentAt. Drafts and terminal quotes are left
 * alone; the clock is sentAt, not creation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { quotesToAutoArchive, QUOTE_AUTO_ARCHIVE_DAYS } from '../src/lib/quoteStages.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const daysAgo = (n) => NOW - n * DAY;

test('archives a sent quote past the window, leaves a fresh one', () => {
  const ids = quotesToAutoArchive([
    { id: 'old', status: 'sent', sentAt: daysAgo(20) },
    { id: 'fresh', status: 'sent', sentAt: daysAgo(3) },
  ], NOW).map((q) => q.id);
  assert.deepEqual(ids, ['old']);
});

test('window is QUOTE_AUTO_ARCHIVE_DAYS (15) — boundary is exclusive', () => {
  assert.equal(QUOTE_AUTO_ARCHIVE_DAYS, 15);
  // Exactly 15 days old is NOT yet swept (must be strictly past the window);
  // a hair older is.
  const atBoundary = quotesToAutoArchive([{ id: 'b', status: 'sent', sentAt: daysAgo(15) }], NOW);
  assert.equal(atBoundary.length, 0);
  const past = quotesToAutoArchive([{ id: 'b', status: 'sent', sentAt: daysAgo(15) - 1 }], NOW);
  assert.deepEqual(past.map((q) => q.id), ['b']);
});

test('never touches drafts, accepted, declined, or already-archived quotes', () => {
  const ids = quotesToAutoArchive([
    { id: 'draft', status: 'draft', sentAt: null },
    { id: 'accepted', status: 'accepted', sentAt: daysAgo(40) },
    { id: 'declined', status: 'declined', sentAt: daysAgo(40) },
    { id: 'archived', status: 'archived', sentAt: daysAgo(40) },
  ], NOW);
  assert.equal(ids.length, 0);
});

test('a sent quote with no sentAt is skipped (can\'t time the window)', () => {
  const ids = quotesToAutoArchive([{ id: 'x', status: 'sent', sentAt: null }], NOW);
  assert.equal(ids.length, 0);
});

test('the window is overridable', () => {
  const q = [{ id: 'x', status: 'sent', sentAt: daysAgo(10) }];
  assert.equal(quotesToAutoArchive(q, NOW, 15).length, 0); // not stale at 15d
  assert.deepEqual(quotesToAutoArchive(q, NOW, 7).map((x) => x.id), ['x']); // stale at 7d
});

test('null/empty input is safe', () => {
  assert.deepEqual(quotesToAutoArchive(null, NOW), []);
  assert.deepEqual(quotesToAutoArchive([], NOW), []);
});
