/**
 * Tests for src/lib/subtype.js — the bridge that splits a free-text
 * subtype column into a Grade + Fabric pair in the UI without ever
 * losing dealer-typed content on round-trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtype, composeSubtype, materialIdentity, canPropagateMaterial, compoundFabric, fabricDisplay } from '../src/lib/subtype.js';

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

test('fabricDisplay — strips the embedded (#code) for client-facing copy', () => {
  assert.equal(fabricDisplay('Grade C — TRAMA · ECRU (#3075)'), 'Grade C — TRAMA · ECRU');
  assert.equal(fabricDisplay('Grade D — SCAN · BEIGE (#1116)'), 'Grade D — SCAN · BEIGE');
  // No code ⇒ unchanged; blank/null ⇒ empty string.
  assert.equal(fabricDisplay('Grade C — PAMPA'), 'Grade C — PAMPA');
  assert.equal(fabricDisplay(''), '');
  assert.equal(fabricDisplay(null), '');
});

test('compoundFabric — uniform when every bearing piece shares one material', () => {
  const mk = (id, subtype, swatch) => ({ id, subtype, swatchImageId: swatch });
  // A sectional whose pieces are all Grade C — TRAMA · Ecru (same swatch).
  const comps = [
    mk('1', 'Grade C — TRAMA · ECRU (#3075)', 'img-ecru'),
    mk('2', 'Grade C — TRAMA · ECRU (#3075)', 'img-ecru'),
  ];
  assert.deepEqual(compoundFabric(comps), {
    uniform: true, subtype: 'Grade C — TRAMA · ECRU (#3075)', swatchImageId: 'img-ecru',
  });
});

test('compoundFabric — NOT uniform when a piece differs (fabric or swatch)', () => {
  const mk = (id, subtype, swatch) => ({ id, subtype, swatchImageId: swatch });
  // Different fabric on one piece (the MODULAR EN L case: sofas TRAMA, bolsters SCAN).
  assert.equal(compoundFabric([
    mk('1', 'Grade C — TRAMA · ECRU (#3075)', 'img-ecru'),
    mk('2', 'Grade D — SCAN · BEIGE (#1116)', 'img-beige'),
  ]).uniform, false);
  // Same fabric label, different colour swatch ⇒ still differs.
  assert.equal(compoundFabric([
    mk('1', 'Grade C — TRAMA', 'img-a'),
    mk('2', 'Grade C — TRAMA', 'img-b'),
  ]).uniform, false);
});

test('compoundFabric — non-bearing pieces (no fabric) do not break uniformity', () => {
  const mk = (id, subtype, swatch) => ({ id, subtype, swatchImageId: swatch });
  // A glass top / metal base carries no grade or fabric — ignored, not a mismatch.
  assert.deepEqual(compoundFabric([
    mk('1', 'Grade C — TRAMA · ECRU (#3075)', 'img-ecru'),
    mk('2', 'Walnut base', null),  // a fabric-less finish counts as bearing (has fabric text)
  ]).uniform, false);
  // Truly blank sub-piece (no grade, no fabric) is skipped.
  assert.deepEqual(compoundFabric([
    mk('1', 'Grade C — TRAMA · ECRU (#3075)', 'img-ecru'),
    mk('2', '', null),
  ]), { uniform: true, subtype: 'Grade C — TRAMA · ECRU (#3075)', swatchImageId: 'img-ecru' });
});

test('compoundFabric — per-piece configuration disqualifies collapsing', () => {
  const mk = (props) => ({ id: 'x', subtype: 'Grade C — TRAMA', swatchImageId: 'img', ...props });
  const base = mk({});
  // A pick-one alternative, a client optional, or an own options grid each mean
  // the piece is meant to be read individually — never collapse the swatch.
  assert.equal(compoundFabric([base, mk({ id: '2', alternativeGroup: 'g1' })]).uniform, false);
  assert.equal(compoundFabric([base, mk({ id: '2', isOptional: true })]).uniform, false);
  assert.equal(compoundFabric([base, mk({ id: '2', optionalOffered: true })]).uniform, false);
  assert.equal(compoundFabric([base, mk({ id: '2', materialOptions: { options: [{ label: 'B' }] } })]).uniform, false);
  // An empty options array is not a grid ⇒ still collapses.
  assert.equal(compoundFabric([base, mk({ id: '2', materialOptions: { options: [] } })]).uniform, true);
});

test('compoundFabric — guards: empty / null / no bearing piece', () => {
  assert.deepEqual(compoundFabric(null), { uniform: false, subtype: '', swatchImageId: null });
  assert.deepEqual(compoundFabric([]), { uniform: false, subtype: '', swatchImageId: null });
  // All pieces blank ⇒ nothing to hoist.
  assert.equal(compoundFabric([{ id: '1', subtype: '' }, { id: '2', subtype: '' }]).uniform, false);
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
