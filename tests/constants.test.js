/**
 * Tests for src/lib/constants.js.
 *
 * The constants themselves are dumb strings — these tests pin the
 * exact values so a future rename of the underlying enum doesn't
 * silently break stored DB rows. (A row with `kind = 'item'` only
 * matches LINE_KIND_ITEM if the constant stays `'item'`.) Also
 * cover the predicate helpers that wrap them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINE_KIND_ITEM,
  LINE_KIND_SECTION,
  LINE_KINDS,
  isPricedLine,
  QUOTE_STATUS_DRAFT,
  QUOTE_STATUS_SENT,
  QUOTE_STATUS_ACCEPTED,
  QUOTE_STATUS_DECLINED,
  QUOTE_STATUS_ARCHIVED,
  QUOTE_STATUSES,
  isActiveQuoteStatus,
} from '../src/lib/constants.js';

/* ---------------------------- line kinds ---------------------------- */

test('LINE_KIND constants pin the stored discriminator values', () => {
  assert.equal(LINE_KIND_ITEM, 'item');
  assert.equal(LINE_KIND_SECTION, 'section');
  assert.deepEqual(LINE_KINDS, ['item', 'section']);
});

test('isPricedLine: items are priced, sections are not', () => {
  assert.equal(isPricedLine({ kind: 'item' }), true);
  assert.equal(isPricedLine({ kind: 'section' }), false);
});

test('isPricedLine: legacy / missing kind defaults to priced (no kind = item)', () => {
  // Old rows that pre-date the kind column have kind=undefined; they
  // should still participate in totals math.
  assert.equal(isPricedLine({}), true);
  assert.equal(isPricedLine(null), true);
});

/* ---------------------------- quote status ---------------------------- */

test('QUOTE_STATUS constants pin the stored values', () => {
  assert.equal(QUOTE_STATUS_DRAFT, 'draft');
  assert.equal(QUOTE_STATUS_SENT, 'sent');
  assert.equal(QUOTE_STATUS_ACCEPTED, 'accepted');
  assert.equal(QUOTE_STATUS_DECLINED, 'declined');
  assert.equal(QUOTE_STATUS_ARCHIVED, 'archived');
});

test('QUOTE_STATUSES lists every status in lifecycle order', () => {
  assert.deepEqual(QUOTE_STATUSES, [
    'draft', 'sent', 'accepted', 'declined', 'archived',
  ]);
});

test('isActiveQuoteStatus: draft + sent are active, the rest are finalised', () => {
  assert.equal(isActiveQuoteStatus('draft'), true);
  assert.equal(isActiveQuoteStatus('sent'), true);
  assert.equal(isActiveQuoteStatus('accepted'), false);
  assert.equal(isActiveQuoteStatus('declined'), false);
  assert.equal(isActiveQuoteStatus('archived'), false);
  // Defensive: unknown status doesn't crash and isn't treated as active.
  assert.equal(isActiveQuoteStatus(undefined), false);
  assert.equal(isActiveQuoteStatus('whatever'), false);
});
