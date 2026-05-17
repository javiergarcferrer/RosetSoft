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

test('parse — every alpha grade in the Ligne Roset taxonomy (A..R, S, U..X)', () => {
  for (const g of ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','U','V','W','X']) {
    assert.deepEqual(parseSubtype(`Grade ${g} — Fabric`), { grade: g, fabric: 'Fabric' },
      `parse failed for Grade ${g}`);
  }
});

test('compose — Pieles letters (U..X) format the same as Telas letters', () => {
  // The taxonomy splits visually into Telas / Microfibras / Pieles, but
  // in the compose format they're all "Grade X" — the group is only a
  // picker-side affordance.
  assert.equal(composeSubtype('U', 'Tea'),   'Grade U — Tea');
  assert.equal(composeSubtype('S', 'Anti'),  'Grade S — Anti');
  assert.equal(composeSubtype('X', ''),      'Grade X');
});

test('parse — legacy "Cuir" / "Leather" round-trip (no longer in picker)', () => {
  // The Cuir grade was deprecated in favour of specific Pieles letter
  // grades U..X, but older quotes may still have "Cuir — Tea" in their
  // subtype column. The parser keeps recognising it so the picker can
  // render a hidden legacy <option> and not lose the dealer's data.
  assert.deepEqual(parseSubtype('Cuir — Tea'), { grade: 'Cuir', fabric: 'Tea' });
  assert.deepEqual(parseSubtype('Leather — black'), { grade: 'Leather', fabric: 'black' });
});

test('compose ∘ parse is identity for every canonical shape', () => {
  // Round-trip property: anything we'd ever WRITE should re-parse to the
  // same pair. (Legacy hand-typed strings that don't follow the schema
  // are allowed to canonicalise on first edit.)
  for (const input of [
    'Grade C — PAMPA',
    'Grade A — Velvet Smoke',
    'Grade H',
    'Grade S — Microfibra',
    'Grade U — Tea',
    'Grade X',
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
