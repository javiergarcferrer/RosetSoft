/**
 * Tests for src/lib/subtype.js — the bridge that splits a free-text
 * subtype column into a Grade + Fabric pair in the UI without ever
 * losing dealer-typed content on round-trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtype, composeSubtype } from '../src/lib/subtype.js';

test('parse — canonical "Grade X — FABRIC"', () => {
  assert.deepEqual(parseSubtype('Grade C — PAMPA'), { grade: 'C', fabric: 'PAMPA' });
  assert.deepEqual(parseSubtype('Grade A — Velvet Smoke'), { grade: 'A', fabric: 'Velvet Smoke' });
});

test('parse — grade alone', () => {
  assert.deepEqual(parseSubtype('Grade C'), { grade: 'C', fabric: '' });
  assert.deepEqual(parseSubtype('Cuir'), { grade: 'Cuir', fabric: '' });
  assert.deepEqual(parseSubtype('COM'), { grade: 'COM', fabric: '' });
});

test('parse — named grades (Cuir, COM)', () => {
  assert.deepEqual(parseSubtype('Cuir — Tea'), { grade: 'Cuir', fabric: 'Tea' });
  assert.deepEqual(parseSubtype('COM — buyer supplied'), { grade: 'COM', fabric: 'buyer supplied' });
});

test('parse — fabric alone (no recognized grade)', () => {
  assert.deepEqual(parseSubtype('Walnut'), { grade: '', fabric: 'Walnut' });
  assert.deepEqual(parseSubtype('Lacquer black'), { grade: '', fabric: 'Lacquer black' });
});

test('parse — handles ASCII hyphen and en-dash separators', () => {
  assert.deepEqual(parseSubtype('Grade C - PAMPA'),  { grade: 'C', fabric: 'PAMPA' });
  assert.deepEqual(parseSubtype('Grade C – PAMPA'),  { grade: 'C', fabric: 'PAMPA' });
});

test('parse — case-insensitive on grade word and named grades', () => {
  assert.deepEqual(parseSubtype('grade c — Pampa'), { grade: 'C', fabric: 'Pampa' });
  assert.deepEqual(parseSubtype('CUIR — Tea'),      { grade: 'Cuir', fabric: 'Tea' });
});

test('parse — empty / null / non-string', () => {
  assert.deepEqual(parseSubtype(''),         { grade: '', fabric: '' });
  assert.deepEqual(parseSubtype(null),       { grade: '', fabric: '' });
  assert.deepEqual(parseSubtype(undefined),  { grade: '', fabric: '' });
  assert.deepEqual(parseSubtype(42),         { grade: '', fabric: '' });
});

test('compose — alpha grades get the "Grade " prefix; named grades do not', () => {
  assert.equal(composeSubtype('C', 'PAMPA'),   'Grade C — PAMPA');
  assert.equal(composeSubtype('Cuir', 'Tea'),  'Cuir — Tea');
  assert.equal(composeSubtype('COM', ''),      'COM');
  assert.equal(composeSubtype('A', ''),        'Grade A');
});

test('compose — only fabric, no grade', () => {
  assert.equal(composeSubtype('', 'Walnut'), 'Walnut');
});

test('compose — empty both sides yields empty string', () => {
  assert.equal(composeSubtype('', ''),         '');
  assert.equal(composeSubtype(null, null),     '');
  assert.equal(composeSubtype(undefined, ''),  '');
});

test('compose ∘ parse is identity for every canonical shape', () => {
  // Round-trip property: anything we'd ever WRITE should re-parse to the
  // same pair. (Legacy hand-typed strings that don't follow the schema
  // are allowed to canonicalise on first edit.)
  for (const input of [
    'Grade C — PAMPA',
    'Grade A — Velvet Smoke',
    'Grade H',
    'Cuir — Tea',
    'Cuir',
    'COM — special',
    'PAMPA',
    'Walnut',
    '',
  ]) {
    const { grade, fabric } = parseSubtype(input);
    const recomposed = composeSubtype(grade, fabric);
    const reparsed = parseSubtype(recomposed);
    assert.deepEqual(reparsed, { grade, fabric }, `round-trip drift for ${JSON.stringify(input)}`);
  }
});
