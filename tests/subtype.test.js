/**
 * Tests for src/lib/subtype.js — the bridge that splits a free-text
 * subtype column into a Grade + Fabric pair in the UI without ever
 * losing dealer-typed content on round-trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtype, composeSubtype, materialIdentity, canPropagateMaterial, compoundFabric, groupComponentsByMaterial, fabricDisplay, fabricMaterialName, fabricColorName, groupPaletteByMaterial } from '../src/lib/subtype.js';

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

test('compoundFabric — per-piece configuration does NOT block uniformity', () => {
  // Whether a piece is independently choosable (a pick-one alternative, a
  // client-optional, its own options grid) is SEPARATE from whether its swatch
  // is redundant. A sectional of four same-CRAQUELIN alternative seats is still
  // uniform — we hoist ONE hero swatch and keep the per-piece radios. (This is
  // the bug the earlier guard caused: such quotes showed the swatch N times.)
  const mk = (props) => ({ id: 'x', subtype: 'Grade C — TRAMA', swatchImageId: 'img', ...props });
  const base = mk({});
  assert.equal(compoundFabric([base, mk({ id: '2', alternativeGroup: 'g1' })]).uniform, true);
  assert.equal(compoundFabric([base, mk({ id: '2', isOptional: true })]).uniform, true);
  assert.equal(compoundFabric([base, mk({ id: '2', optionalOffered: true })]).uniform, true);
  assert.equal(compoundFabric([base, mk({ id: '2', materialOptions: { options: [{ label: 'B' }] } })]).uniform, true);
  // But a piece in a genuinely DIFFERENT fabric still breaks uniformity.
  assert.equal(compoundFabric([base, mk({ id: '2', subtype: 'Grade D — SCAN', swatchImageId: 'img2' })]).uniform, false);
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

/* ---- groupComponentsByMaterial — frame fabric vs cushion fabric ---------- */

test('group — 2 materials split into material groups (frame, then cushions)', () => {
  const g = groupComponentsByMaterial([
    { id: 's1', subtype: 'Grade C — PAMPA' },
    { id: 's2', subtype: 'Grade C — PAMPA' },
    { id: 'c1', subtype: 'Grade A — VELVET' },
    { id: 'c2', subtype: 'Grade A — VELVET' },
  ]);
  assert.equal(g.grouped, true);
  assert.equal(g.runs.length, 2);
  assert.deepEqual(g.runs.map((r) => r.components.map((c) => c.id)), [['s1', 's2'], ['c1', 'c2']]);
  assert.deepEqual(g.runs.map((r) => r.bearing), [true, true]);
  assert.deepEqual(g.runs.map((r) => r.subtype), ['Grade C — PAMPA', 'Grade A — VELVET']);
});

test('group — uniform compound does NOT group (one hero handles it)', () => {
  const g = groupComponentsByMaterial([
    { id: 'a', subtype: 'Grade C — PAMPA' },
    { id: 'b', subtype: 'Grade C — PAMPA' },
  ]);
  assert.equal(g.grouped, false);
  assert.deepEqual(g.runs, []);
});

test('group — no material-bearing pieces does NOT group', () => {
  const g = groupComponentsByMaterial([
    { id: 'm', subtype: '' },
    { id: 'n', subtype: '' },
  ]);
  assert.equal(g.grouped, false);
});

test('group — same swatchImageId distinguishes an otherwise-equal subtype', () => {
  const g = groupComponentsByMaterial([
    { id: 'a', subtype: 'Grade C — PAMPA', swatchImageId: 'beige' },
    { id: 'b', subtype: 'Grade C — PAMPA', swatchImageId: 'grey' },
  ]);
  assert.equal(g.grouped, true);
  assert.equal(g.runs.length, 2);
});

test('group — non-bearing piece forms its own header-less run between materials', () => {
  const g = groupComponentsByMaterial([
    { id: 's', subtype: 'Grade C — PAMPA' },
    { id: 'base', subtype: '' },          // metal base: no fabric
    { id: 'c', subtype: 'Grade A — VELVET' },
  ]);
  assert.equal(g.grouped, true);
  assert.deepEqual(g.runs.map((r) => r.bearing), [true, false, true]);
  assert.equal(g.runs[1].subtype, '');     // header-less
});

test('group — interleaved same-material pieces CLUSTER under one swatch', () => {
  // Same fabric must collapse to ONE group even when interleaved with another
  // material, so the PDF/preview shows one big swatch per fabric (not repeated).
  const g = groupComponentsByMaterial([
    { id: 'a1', subtype: 'Grade C — PAMPA' },
    { id: 'b1', subtype: 'Grade A — VELVET' },
    { id: 'a2', subtype: 'Grade C — PAMPA' },
  ]);
  assert.equal(g.grouped, true);
  assert.equal(g.runs.length, 2); // PAMPA clusters a1+a2; VELVET its own
  // First-appearance order of materials: PAMPA then VELVET.
  assert.deepEqual(g.runs.map((r) => r.components.map((c) => c.id)), [['a1', 'a2'], ['b1']]);
});

test('fabricMaterialName / fabricColorName — split a "MATERIAL · COLOR (#code)" label', () => {
  assert.equal(fabricMaterialName('ERPI · ARGILE (#973)'), 'ERPI');
  assert.equal(fabricColorName('ERPI · ARGILE (#973)'), 'ARGILE');
  // Material-only label: no colour segment.
  assert.equal(fabricMaterialName('ERPI'), 'ERPI');
  assert.equal(fabricColorName('ERPI'), '');
  // Blank / nullish are safe.
  assert.equal(fabricMaterialName(''), '');
  assert.equal(fabricColorName(null), '');
});

test('groupPaletteByMaterial — colours of one material collapse under it, order kept', () => {
  const groups = groupPaletteByMaterial([
    { id: '1', grade: 'D', fabric: 'ERPI · ARGILE (#973)' },
    { id: '2', grade: 'C', fabric: 'VIDAR · 0323 (#5)' },
    { id: '3', grade: 'D', fabric: 'ERPI · NOIR (#100)' },
  ]);
  // ERPI first (first-seen), then VIDAR — not reordered.
  assert.deepEqual(groups.map((g) => g.material), ['ERPI', 'VIDAR']);
  // Both ERPI colours land in one group; the group's grade is the first entry's.
  assert.deepEqual(groups[0].items.map((m) => m.id), ['1', '3']);
  assert.equal(groups[0].grade, 'D');
  assert.equal(groups[1].items.length, 1);
});
