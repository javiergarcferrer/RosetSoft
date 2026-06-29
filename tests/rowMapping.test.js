/**
 * Contract tests for the camelCase <-> snake_case row mappers in
 * src/db/rowMapping.ts.
 *
 * Two invariants are pinned here:
 *
 *  1. TOP-LEVEL ONLY. fromRow/toRow convert only the own keys of the object
 *     handed in; they do NOT recurse. A nested object (a `jsonb` blob like
 *     `exchangeRate` or `settings`) is passed through verbatim — its inner
 *     keys keep their casing and a nested `*At` field is NOT coerced. This is
 *     deliberate: jsonb columns round-trip their own shape through Postgres,
 *     so recursing would silently rename a dealer's settings keys. The
 *     load-bearing case: `exchangeRate.updatedAt` must stay a NUMBER across
 *     fromRow/toRow (the UI does plain `Date.now() - updatedAt` math on it).
 *
 *  2. *At coercion at the TOP level is symmetric and round-trip stable: a JS
 *     millisecond timestamp -> ISO string on the way to Postgres, and back to
 *     the same millisecond number on the way in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toRow, fromRow, fromRows, snake, camel, isAtField } from '../src/db/rowMapping.js';

test('snake/camel are inverse for simple names', () => {
  assert.equal(snake('commissionPct'), 'commission_pct');
  assert.equal(camel('commission_pct'), 'commissionPct');
  assert.equal(camel(snake('lineDiscountPct')), 'lineDiscountPct');
});

test('isAtField matches only *At suffix', () => {
  assert.equal(isAtField('createdAt'), true);
  assert.equal(isAtField('lastSignInAt'), true);
  assert.equal(isAtField('updatedAt'), true);
  assert.equal(isAtField('rate'), false);
  assert.equal(isAtField('attachment'), false); // ends in "ment", not "At"
});

test('toRow coerces a top-level *At number to an ISO string', () => {
  const ms = Date.UTC(2026, 0, 15, 12, 0, 0);
  const row = toRow({ id: 'x', createdAt: ms });
  assert.equal(row.id, 'x');
  assert.equal(typeof row.created_at, 'string');
  assert.equal(row.created_at, new Date(ms).toISOString());
});

test('fromRow coerces a top-level *At ISO string back to a number', () => {
  const ms = Date.UTC(2026, 0, 15, 12, 0, 0);
  const iso = new Date(ms).toISOString();
  const obj = fromRow({ id: 'x', created_at: iso });
  assert.equal(obj.id, 'x');
  assert.equal(typeof obj.createdAt, 'number');
  assert.equal(obj.createdAt, ms);
});

test('top-level *At round-trip is stable (ms -> ISO -> ms)', () => {
  const ms = Date.now();
  const back = fromRow(toRow({ id: 'q1', updatedAt: ms }));
  assert.equal(back.updatedAt, ms);
  assert.equal(typeof back.updatedAt, 'number');
});

test('fromRow passes null/undefined/primitives through', () => {
  assert.equal(fromRow(null), null);
  assert.equal(fromRow(undefined), undefined);
  assert.equal(fromRow('plain'), 'plain');
  assert.equal(fromRow(42), 42);
});

test('NESTED jsonb keeps camelCase and skips *At coercion (top-level only)', () => {
  const settings = {
    profileId: 'team',
    // jsonb blob — its interior must NOT be touched by the mapper.
    exchangeRate: { buy: 58, sell: 60, updatedAt: 1737000000000 },
  };

  const row = toRow(settings);
  // Top-level key snake-cased; the nested blob is passed through verbatim.
  assert.equal(row.profile_id, 'team');
  assert.deepEqual(row.exchange_rate, settings.exchangeRate);
  // The load-bearing assertion: nested updatedAt stays a NUMBER (not ISO).
  assert.equal(typeof row.exchange_rate.updatedAt, 'number');
  assert.equal(row.exchange_rate.updatedAt, 1737000000000);
  // And the nested key keeps camelCase (not snake_cased to updated_at).
  assert.equal('updatedAt' in row.exchange_rate, true);
  assert.equal('updated_at' in row.exchange_rate, false);
});

test('NESTED exchangeRate.updatedAt stays numeric across a full round-trip', () => {
  const ms = 1737000000000;
  const settings = { profileId: 'team', exchangeRate: { buy: 58, sell: 60, updatedAt: ms } };
  const back = fromRow(toRow(settings));
  assert.equal(back.profileId, 'team');
  assert.equal(typeof back.exchangeRate.updatedAt, 'number');
  assert.equal(back.exchangeRate.updatedAt, ms);
  // The whole nested blob is identical after the round-trip.
  assert.deepEqual(back.exchangeRate, settings.exchangeRate);
});

test('arrays of nested objects (e.g. components[]) are not recursed', () => {
  const line = {
    id: 'l1',
    createdAt: 1737000000000,
    // jsonb array — inner createdAt must stay a number, key stays camelCase.
    components: [{ name: 'base', createdAt: 1737000000000 }],
  };
  const row = toRow(line);
  assert.equal(typeof row.created_at, 'string'); // top-level coerced
  assert.equal(typeof row.components[0].createdAt, 'number'); // nested untouched
  assert.equal(row.components[0].name, 'base');
});

test('fromRows maps a list and tolerates null/undefined input', () => {
  assert.deepEqual(fromRows(null), []);
  assert.deepEqual(fromRows(undefined), []);
  const out = fromRows([{ id: 'a', created_at: new Date(0).toISOString() }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
  assert.equal(out[0].createdAt, 0);
});

test('toRow tolerates null/undefined input', () => {
  assert.deepEqual(toRow(null), {});
  assert.deepEqual(toRow(undefined), {});
});
