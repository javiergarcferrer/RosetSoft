/**
 * Tests for src/lib/subtype.js — the bridge that splits a free-text
 * subtype column into a Grade + Fabric pair in the UI without ever
 * losing dealer-typed content on round-trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtype, composeSubtype, materialIdentity, canPropagateMaterial } from '../src/lib/subtype.js';

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

test('materialIdentity — equal subtype + swatch ⇒ equal keys; either differing ⇒ not', () => {
  const a = { subtype: 'Grade C — PAMPA', swatchImageId: 'img1' };
  assert.equal(materialIdentity(a), materialIdentity({ subtype: 'Grade C — PAMPA', swatchImageId: 'img1' }));
  // trims subtype so trailing whitespace doesn't fork identity
  assert.equal(materialIdentity(a), materialIdentity({ subtype: 'Grade C — PAMPA ', swatchImageId: 'img1' }));
  assert.notEqual(materialIdentity(a), materialIdentity({ subtype: 'Grade C — PAMPA', swatchImageId: 'img2' }));
  assert.notEqual(materialIdentity(a), materialIdentity({ subtype: 'Grade D — PAMPA', swatchImageId: 'img1' }));
  // null/undefined collapse to the empty-material key, never throw
  assert.equal(materialIdentity(null), materialIdentity({ subtype: '', swatchImageId: null }));
});

test('materialIdentity — a fabric name can never collide with a swatch id', () => {
  // Encoding the pair (rather than concatenating) means a fabric whose text
  // happens to look like "<other>][<id>" can't masquerade as another pairing.
  assert.notEqual(
    materialIdentity({ subtype: 'A', swatchImageId: 'B' }),
    materialIdentity({ subtype: 'A","B', swatchImageId: '' }),
  );
});

test('canPropagateMaterial — offered only when there is redundancy to remove', () => {
  const mk = (id, subtype, swatch) => ({ id, subtype, swatchImageId: swatch });
  const src = mk('1', 'Grade C — PAMPA', 'img1');

  // A lone piece has no siblings to apply to.
  assert.equal(canPropagateMaterial(src, [src]), false);
  // A blank source carries no material worth applying.
  assert.equal(canPropagateMaterial(mk('1', '', null), [mk('1', '', null), mk('2', 'Grade C — PAMPA', 'img1')]), false);
  // A differing sibling (here: still blank) ⇒ offer it.
  assert.equal(canPropagateMaterial(src, [src, mk('2', '', null)]), true);
  // A sibling in the same fabric but a different colour swatch still differs.
  assert.equal(canPropagateMaterial(src, [src, mk('2', 'Grade C — PAMPA', 'img2')]), true);
  // Everything already matches ⇒ hide it (would be a no-op).
  assert.equal(canPropagateMaterial(src, [src, mk('2', 'Grade C — PAMPA', 'img1')]), false);
  // Guards: missing/short sibling lists never throw.
  assert.equal(canPropagateMaterial(src, null), false);
  assert.equal(canPropagateMaterial(src, []), false);
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
