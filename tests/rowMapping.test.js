/**
 * Tests for src/db/rowMapping.js — the camelCase ↔ snake_case +
 * *At timestamp coercion contract that every Supabase round-trip
 * routes through.
 *
 * The commission-pct bug we shipped earlier (Users.jsx reading
 * profile.commission_pct on a camelCased object → always undefined)
 * was exactly the class of regression these tests are here to catch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snake,
  camel,
  isAtField,
  toRow,
  fromRow,
  fromRows,
} from '../src/db/rowMapping.js';

/* ----------------------------------- snake ----------------------------------- */

test('snake: lowercases every uppercase letter prefixed with underscore', () => {
  assert.equal(snake('commissionPct'), 'commission_pct');
  assert.equal(snake('lineDiscountPct'), 'line_discount_pct');
  assert.equal(snake('createdAt'), 'created_at');
  assert.equal(snake('passwordSetAt'), 'password_set_at');
});

test('snake: idempotent on already-snake_case names', () => {
  // Critical: the bug fix that let `commit({ commission_pct: pct })` write
  // correctly relied on snake() being a no-op when the input is already
  // snake. If this regressed (e.g. snake started doubling underscores),
  // every direct snake_case write across the app would corrupt.
  assert.equal(snake('commission_pct'), 'commission_pct');
  assert.equal(snake('created_at'), 'created_at');
  assert.equal(snake('id'), 'id');
});

test('snake: single-word names pass through', () => {
  assert.equal(snake('name'), 'name');
  assert.equal(snake('id'), 'id');
  assert.equal(snake('email'), 'email');
});

test('snake: handles leading uppercase (unusual but defensive)', () => {
  // The codebase never sends a PascalCase key, but if it did we
  // wouldn't want to silently strip the underscore.
  assert.equal(snake('Hello'), '_hello');
});

/* ----------------------------------- camel ----------------------------------- */

test('camel: converts snake_case to camelCase', () => {
  assert.equal(camel('commission_pct'), 'commissionPct');
  assert.equal(camel('line_discount_pct'), 'lineDiscountPct');
  assert.equal(camel('created_at'), 'createdAt');
  assert.equal(camel('password_set_at'), 'passwordSetAt');
  assert.equal(camel('created_by_user_id'), 'createdByUserId');
});

test('camel: idempotent on already-camelCase names', () => {
  assert.equal(camel('commissionPct'), 'commissionPct');
  assert.equal(camel('id'), 'id');
});

test('camel ∘ snake is identity for canonical camelCase input', () => {
  for (const k of [
    'commissionPct', 'lineDiscountPct', 'createdAt', 'passwordSetAt',
    'createdByUserId', 'profileId', 'customerId',
    'id', 'name', 'email',
  ]) {
    assert.equal(camel(snake(k)), k, `round-trip failed for ${k}`);
  }
});

/* --------------------------------- isAtField --------------------------------- */

test('isAtField: every *At suffix is a timestamp field', () => {
  assert.equal(isAtField('createdAt'), true);
  assert.equal(isAtField('updatedAt'), true);
  assert.equal(isAtField('depositReceivedAt'), true);
  assert.equal(isAtField('lastSignInAt'), true);
  assert.equal(isAtField('passwordSetAt'), true);
});

test('isAtField: similar-looking non-timestamp keys are excluded', () => {
  // The match has to be anchored at the end — "name", "address",
  // "format", "stat" don't end with `At`.
  assert.equal(isAtField('name'), false);
  assert.equal(isAtField('address'), false);
  assert.equal(isAtField('format'), false);
  assert.equal(isAtField('stat'), false);
  // Lowercase "at" anywhere doesn't count either.
  assert.equal(isAtField('treaty'), false);
});

/* ----------------------------------- toRow ----------------------------------- */

test('toRow: snake-cases every key and preserves values', () => {
  assert.deepEqual(
    toRow({ commissionPct: 15, lineDiscountPct: 10, id: 'abc' }),
    { commission_pct: 15, line_discount_pct: 10, id: 'abc' },
  );
});

test('toRow: *At numeric timestamps become ISO-8601 strings', () => {
  const ts = Date.parse('2026-05-19T12:00:00.000Z');
  const out = toRow({ createdAt: ts, name: 'X' });
  assert.equal(out.created_at, '2026-05-19T12:00:00.000Z');
  assert.equal(out.name, 'X');
});

test('toRow: non-finite *At values pass through as-is (defensive)', () => {
  // If a buggy upstream sends NaN / null / undefined for an *At
  // field, we don't want to crash; let Postgres complain.
  const out = toRow({ createdAt: null, updatedAt: undefined, scaledAt: NaN });
  assert.equal(out.created_at, null);
  assert.equal(out.updated_at, undefined);
  assert.ok(Number.isNaN(out.scaled_at));
});

test('toRow: string *At values pass through (already-ISO from upstream)', () => {
  // A `put` cycle after a `get` may carry ISO strings rather than
  // numbers; we shouldn't double-encode them.
  const out = toRow({ createdAt: '2026-05-19T12:00:00.000Z' });
  assert.equal(out.created_at, '2026-05-19T12:00:00.000Z');
});

test('toRow: null / undefined input → empty object (no crash)', () => {
  assert.deepEqual(toRow(null), {});
  assert.deepEqual(toRow(undefined), {});
});

/* ---------------------------------- fromRow ---------------------------------- */

test('fromRow: camelCases every key and preserves values', () => {
  assert.deepEqual(
    fromRow({ commission_pct: 15, line_discount_pct: 10, id: 'abc' }),
    { commissionPct: 15, lineDiscountPct: 10, id: 'abc' },
  );
});

test('fromRow: *At ISO strings become numeric timestamps', () => {
  const out = fromRow({ created_at: '2026-05-19T12:00:00.000Z', name: 'X' });
  assert.equal(out.createdAt, Date.parse('2026-05-19T12:00:00.000Z'));
  assert.equal(out.name, 'X');
});

test('fromRow: malformed *At strings pass through unchanged', () => {
  // If Postgres ever hands us a non-parseable string we keep it as-is
  // rather than coerce to NaN, so the UI sees the literal value and
  // can either render it or surface a useful error.
  const out = fromRow({ created_at: 'not-a-date' });
  assert.equal(out.createdAt, 'not-a-date');
});

test('fromRow: null input → null (do NOT wrap in {})', () => {
  // Critical: `db.X.get()` returns null on no-match via
  // .maybeSingle(). If fromRow turned that into {} the caller would
  // see "row exists with no fields" instead of "no row".
  assert.equal(fromRow(null), null);
  assert.equal(fromRow(undefined), undefined);
});

test('fromRow: primitive inputs pass through unchanged', () => {
  assert.equal(fromRow(42), 42);
  assert.equal(fromRow('hello'), 'hello');
});

test('fromRow: regression — commission_pct must surface as commissionPct', () => {
  // The bug that prompted these tests in the first place. Lock in
  // the contract so future refactors of the converter can't
  // re-introduce the snake-key-on-camelCased-object class of bug.
  const dbRow = {
    id: 'u1',
    name: 'María',
    role: 'employee',
    active: true,
    commission_pct: 15,
    last_sign_in_at: '2026-05-19T12:00:00.000Z',
  };
  const js = fromRow(dbRow);
  assert.equal(js.commissionPct, 15);
  assert.equal(js.commission_pct, undefined);
  assert.equal(js.lastSignInAt, Date.parse('2026-05-19T12:00:00.000Z'));
});

/* --------------------------------- round-trip --------------------------------- */

test('toRow ∘ fromRow is identity on a representative profile row', () => {
  // The most-trafficked entity in the app. Anything that round-trips
  // here will round-trip for the smaller entities (settings, lines,
  // orders) too.
  const start = {
    id: 'u1',
    name: 'María',
    email: 'maria@alcover.do',
    role: 'employee',
    active: true,
    commissionPct: 15,
    createdAt: Date.parse('2026-05-01T10:00:00.000Z'),
    updatedAt: Date.parse('2026-05-19T12:00:00.000Z'),
    lastSignInAt: Date.parse('2026-05-19T11:30:00.000Z'),
    passwordSetAt: Date.parse('2026-05-01T10:00:01.000Z'),
  };
  const roundTrip = fromRow(toRow(start));
  assert.deepEqual(roundTrip, start);
});

test('toRow ∘ fromRow handles a quote row with compound + adjustments', () => {
  const start = {
    id: 'q1',
    profileId: 'team',
    customerId: 'c1',
    professionalId: 'p1',
    commissionPct: 12,
    currencyCode: 'USD',
    marginPct: 0,
    discountPct: 5,
    shipping: 250,
    status: 'sent',
    sentAt: Date.parse('2026-05-19T12:00:00.000Z'),
    createdAt: Date.parse('2026-05-15T09:00:00.000Z'),
    updatedAt: Date.parse('2026-05-19T12:30:00.000Z'),
  };
  assert.deepEqual(fromRow(toRow(start)), start);
});

/* ---------------------------------- fromRows --------------------------------- */

test('fromRows: maps every row through fromRow', () => {
  assert.deepEqual(
    fromRows([
      { commission_pct: 15 },
      { commission_pct: 20, created_at: '2026-05-19T12:00:00.000Z' },
    ]),
    [
      { commissionPct: 15 },
      { commissionPct: 20, createdAt: Date.parse('2026-05-19T12:00:00.000Z') },
    ],
  );
});

test('fromRows: null / undefined input → empty array', () => {
  assert.deepEqual(fromRows(null), []);
  assert.deepEqual(fromRows(undefined), []);
});
