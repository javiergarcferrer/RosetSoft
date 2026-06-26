/**
 * Tests for shouldPullSessionRate in src/lib/exchangeRate.ts.
 *
 * The rule: the Banco Popular pull fires on EVERY app session, so today's
 * rate always lands — opening the app is enough, no 08:00 gate and no
 * once-a-day marker that a quiet morning or an upstream hiccup could let
 * slip by. The only guard is a short throttle: a dealer reloading the app
 * a few times in a row (or StrictMode's double mount) reuses the figure
 * just fetched instead of hammering the bank's rate-limited API.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldPullSessionRate, displayRatesFor, quoteRateState } from '../src/lib/exchangeRate.js';

// Build a ms timestamp for a given AST wall-clock by pinning the -04:00 offset.
const ast = (iso) => Date.parse(`${iso}-04:00`);
const withRate = (updatedAt) => ({ exchangeRate: { buy: 58, sell: 60, updatedAt } });
const MINUTE = 60_000;

test('pulls when the rate was never fetched', () => {
  assert.equal(shouldPullSessionRate(null), true);
  assert.equal(shouldPullSessionRate({}), true);
  assert.equal(shouldPullSessionRate(withRate(null)), true);
});

test('pulls on a new session once the throttle window has passed', () => {
  const updatedAt = ast('2026-05-28T09:00:00');
  const now = updatedAt + 31 * MINUTE; // 31 min later — a genuine new session
  assert.equal(shouldPullSessionRate(withRate(updatedAt), now), true);
});

test('does NOT re-pull within the throttle window (rapid reloads)', () => {
  const updatedAt = ast('2026-05-28T09:00:00');
  const now = updatedAt + 5 * MINUTE; // reloaded 5 min later
  assert.equal(shouldPullSessionRate(withRate(updatedAt), now), false);
});

test('pulls on the first session of the day with a prior-day rate', () => {
  const updatedAt = ast('2026-05-27T15:00:00'); // yesterday afternoon
  const now = ast('2026-05-28T09:00:00');        // today
  assert.equal(shouldPullSessionRate(withRate(updatedAt), now), true);
});

test('pulls even before 08:00 — no morning gate to miss', () => {
  const updatedAt = ast('2026-05-27T15:00:00'); // yesterday afternoon
  const now = ast('2026-05-28T06:00:00');        // today, before 08:00
  assert.equal(shouldPullSessionRate(withRate(updatedAt), now), true);
});

test('refreshes a multi-day-stale rate', () => {
  const updatedAt = ast('2026-05-25T10:00:00'); // 3 days old
  const now = ast('2026-05-28T06:00:00');
  assert.equal(shouldPullSessionRate(withRate(updatedAt), now), true);
});

test('fires exactly at the throttle boundary', () => {
  const updatedAt = ast('2026-05-28T09:00:00');
  const now = updatedAt + 30 * MINUTE; // exactly 30 min later
  assert.equal(shouldPullSessionRate(withRate(updatedAt), now), true);
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
  assert.equal(shouldPullSessionRate({ bsc: { sell: 60, updatedAt: stale } }, now), true);
  // a figure pulled minutes ago under the legacy key → still within the throttle
  assert.equal(
    shouldPullSessionRate({ bpd: { sell: 60, updatedAt: now - 5 * MINUTE } }, now),
    false,
  );
});
