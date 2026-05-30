/**
 * Tests for shouldPullDailyRate in src/lib/exchangeRate.ts.
 *
 * The rule: the daily Banco Popular pull fires on the first app load
 * at/after 08:00 Santo Domingo time (AST, UTC-4, no DST) on a day whose
 * post-08:00 rate hasn't been captured yet. The bank publishes one rate
 * each morning, so pulling earlier would only re-fetch yesterday's figure
 * and then mark the day done — the gate at 08:00 prevents that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldPullDailyRate, displayRatesFor, quoteRateState } from '../src/lib/exchangeRate.js';

// Build a ms timestamp for a given AST wall-clock by pinning the -04:00 offset.
const ast = (iso) => Date.parse(`${iso}-04:00`);
const withRate = (updatedAt) => ({ exchangeRate: { buy: 58, sell: 60, updatedAt } });

test('pulls when the rate was never fetched', () => {
  assert.equal(shouldPullDailyRate(null), true);
  assert.equal(shouldPullDailyRate({}), true);
  assert.equal(shouldPullDailyRate(withRate(null)), true);
});

test('pulls on the first login at/after 08:00 with a prior-day rate', () => {
  const updatedAt = ast('2026-05-27T15:00:00'); // yesterday afternoon
  const now = ast('2026-05-28T09:00:00');        // today, after 08:00
  assert.equal(shouldPullDailyRate(withRate(updatedAt), now), true);
});

test('does NOT pull before 08:00 when yesterday’s rate is still fresh', () => {
  const updatedAt = ast('2026-05-27T15:00:00'); // yesterday afternoon
  const now = ast('2026-05-28T06:00:00');        // today, before 08:00
  assert.equal(shouldPullDailyRate(withRate(updatedAt), now), false);
});

test('does NOT pull again once today’s post-08:00 rate is captured', () => {
  const updatedAt = ast('2026-05-28T08:30:00'); // today, just after publish
  const now = ast('2026-05-28T11:00:00');        // later today
  assert.equal(shouldPullDailyRate(withRate(updatedAt), now), false);
});

test('a pre-08:00 pull does not satisfy the day — re-pulls after 08:00', () => {
  const updatedAt = ast('2026-05-28T06:00:00'); // pulled before publish
  const now = ast('2026-05-28T09:00:00');        // now after publish
  assert.equal(shouldPullDailyRate(withRate(updatedAt), now), true);
});

test('refreshes a multi-day-stale rate even before 08:00', () => {
  const updatedAt = ast('2026-05-25T10:00:00'); // 3 days old
  const now = ast('2026-05-28T06:00:00');        // before today’s 08:00
  assert.equal(shouldPullDailyRate(withRate(updatedAt), now), true);
});

test('fires exactly at the 08:00 boundary', () => {
  const updatedAt = ast('2026-05-27T15:00:00');
  const now = ast('2026-05-28T08:00:00');        // exactly 08:00 AST
  assert.equal(shouldPullDailyRate(withRate(updatedAt), now), true);
});

/* ----------------------- quoteRateState (single source of truth) ---------------------- */

test('quoteRateState — one source for BOTH the lock flag and the rate map', () => {
  const settings = { exchangeRate: { buy: 58, sell: 62, updatedAt: 1 } }; // live venta = 62
  // Not accepted → unlocked + live rate (the padlock must read the SAME).
  const sent = quoteRateState({ status: 'sent', sentAt: 1, rates: { USD: 1, DOP: 50 } }, settings);
  assert.equal(sent.locked, false);
  assert.equal(sent.rates.DOP, 62);
  assert.equal(sent.dopRate, 62);
  // Accepted → locked + the frozen snapshot.
  const acc = quoteRateState({ status: 'accepted', acceptedAt: 9, rates: { USD: 1, DOP: 55 } }, settings);
  assert.equal(acc.locked, true);
  assert.deepEqual(acc.rates, { USD: 1, DOP: 55 });
  assert.equal(acc.dopRate, 55);
  // displayRatesFor is literally the `.rates` of the same state — they can't diverge.
  assert.deepEqual(displayRatesFor({ acceptedAt: 9, rates: { USD: 1, DOP: 55 } }, settings), acc.rates);
});

/* ----------------------- displayRatesFor (the accept-time lock) ---------------------- */

test('displayRatesFor — live until ACCEPTED, then the frozen snapshot', () => {
  const settings = { exchangeRate: { buy: 58, sell: 62, updatedAt: 1 } }; // live venta = 62
  // Draft / sent (not yet accepted) → today's live rate, NOT the stale field.
  assert.equal(displayRatesFor({ status: 'draft', rates: { USD: 1, DOP: 50 } }, settings).DOP, 62);
  assert.equal(displayRatesFor({ status: 'sent', sentAt: 1, rates: { USD: 1, DOP: 50 } }, settings).DOP, 62);
  // Declined (was never accepted) → live too.
  assert.equal(displayRatesFor({ status: 'declined', rates: { USD: 1, DOP: 50 } }, settings).DOP, 62);
  // Accepted with a snapshot → the FROZEN snapshot, not the live rate.
  assert.deepEqual(
    displayRatesFor({ status: 'accepted', acceptedAt: 123, rates: { USD: 1, DOP: 55 } }, settings),
    { USD: 1, DOP: 55 },
  );
  // Accepted but no snapshot yet → falls back to live.
  assert.equal(displayRatesFor({ acceptedAt: 9, rates: null }, settings).DOP, 62);
  // No quote / no settings → live fallback (effectiveDopRate default 60).
  assert.equal(displayRatesFor(null, null).DOP, 60);
});

test('reads the legacy bsc / bpd shapes as fallbacks', () => {
  const now = ast('2026-05-28T09:00:00');
  const stale = ast('2026-05-27T15:00:00');
  assert.equal(shouldPullDailyRate({ bsc: { sell: 60, updatedAt: stale } }, now), true);
  // a fresh today-after-08:00 figure under the legacy key → no pull
  assert.equal(
    shouldPullDailyRate({ bpd: { sell: 60, updatedAt: ast('2026-05-28T08:15:00') } }, now),
    false,
  );
});
