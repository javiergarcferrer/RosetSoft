// Parity contract across the Deno↔Vite wall.
//
// The recipient's pick on a public quote link is applied by TWO reducers that
// can't share code (separate runtimes): the optimistic CLIENT one
// (src/core/quote/actions.js `applyAction`, reducing the client-facing bundle)
// and the authoritative SERVER one (supabase/functions/quote-share/pick.ts
// `applyPicks`, reducing the persisted rows). They are deliberate copies — this
// test is what keeps them from drifting: it runs the SAME corpus of picks
// through both and asserts they make the SAME DECISIONS. If a rule is changed on
// one side only, this goes red.
//
// What's compared is the shared RULE, not byte-equal output — the two operate on
// different shapes on purpose:
//   • client lines are camelCase (unitPrice, isSelectedAlternative, …); server
//     LINE patches are snake_case (unit_price, is_selected_alternative, …).
//     Components are camelCase JSONB on BOTH sides, so they compare directly.
//   • client material prices come from baked per-option `delta`s; server prices
//     come from the catalog. Fixtures set base unit = catalog base price and
//     delta = (grade price − base price) with margin 1, so both land on the same
//     final unit. The re-anchored materialOptions.options array legitimately
//     differs (client carries re-based deltas, the server source has none), so
//     parity is asserted on the anchoring decision (baseGrade/label, unit,
//     subtype, reference, swatch, range cleared) — not the options internals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyClientPick } from '../src/lib/clientPick.js';
import { applyPicks } from '../supabase/functions/quote-share/pick.ts';

// ── Parallel fixtures: the SAME quote, in each layer's shape ─────────────────

// Client-facing bundle (camelCase, deltas baked, margin 1).
function clientBundle() {
  return {
    quote: { currencyCode: 'USD', rates: { USD: 1 } },
    lines: [
      { id: 'a', alternativeGroup: 'g1', isSelectedAlternative: true, name: 'Opción A', unitPrice: 100, qty: 1 },
      { id: 'b', alternativeGroup: 'g1', isSelectedAlternative: false, name: 'Opción B', unitPrice: 120, qty: 1 },
      { id: 'opt', isOptional: true, optionalOffered: true, name: 'Cojín', unitPrice: 50, qty: 1 },
      { id: 'optLocked', isOptional: true, name: 'Garantía', unitPrice: 80, qty: 1 },
      {
        id: 'm', name: 'Sofá', reference: '12345678A', subtype: 'Grade A — Tela X',
        unitPrice: 100, qty: 2, swatchImageId: 'sw-A',
        // Per-grade model prices (margin 1 ⇒ equal to the catalog) so the full
        // picker can reprice optimistically; the server reprices from priceMap().
        gradePrices: { A: 100, C: 150, D: 190 },
        materialOptions: {
          baseGrade: 'A', baseLabel: 'Tela X', options: [
            { grade: 'C', label: 'Tela Y', code: '111', swatchImageId: 'sw-C', delta: 50 },
            { grade: 'D', label: 'Cuero Z', code: '222', swatchImageId: 'sw-D', delta: 90 },
          ],
        },
      },
      {
        id: 'cmp', name: 'Modular', components: [
          {
            id: 'c1', name: 'Chaise', reference: '87654321A', subtype: 'Grade A — Tela X',
            unitPrice: 200, qty: 1, swatchImageId: 'sw-cA',
            gradePrices: { A: 200, C: 230 },
            materialOptions: { baseGrade: 'A', baseLabel: 'Tela X', options: [{ grade: 'C', label: 'Tela Y', swatchImageId: 'sw-cC', delta: 30 }] },
          },
          { id: 'c2', name: 'Otomana', unitPrice: 75, qty: 1, isOptional: true, optionalOffered: true },
          { id: 'c3', name: 'Garantía', unitPrice: 20, qty: 1, isOptional: true },
          { id: 'p', alternativeGroup: 'cg', isSelectedAlternative: true, name: 'Tela', unitPrice: 100, qty: 1 },
          { id: 'q', alternativeGroup: 'cg', isSelectedAlternative: false, name: 'Cuero', unitPrice: 200, qty: 1 },
        ],
      },
    ],
  };
}

// Persisted rows (snake_case LINE columns; camelCase JSONB components).
function serverRows() {
  return [
    { id: 'a', alternative_group: 'g1', is_selected_alternative: true, name: 'Opción A', unit_price: 100, qty: 1 },
    { id: 'b', alternative_group: 'g1', is_selected_alternative: false, name: 'Opción B', unit_price: 120, qty: 1 },
    { id: 'opt', is_optional: true, optional_offered: true, name: 'Cojín', unit_price: 50, qty: 1 },
    { id: 'optLocked', is_optional: true, name: 'Garantía', unit_price: 80, qty: 1 },
    {
      id: 'm', name: 'Sofá', reference: '12345678A', subtype: 'Grade A — Tela X',
      unit_price: 100, qty: 2, swatch_image_id: 'sw-A',
      material_options: {
        baseGrade: 'A', baseLabel: 'Tela X', options: [
          { grade: 'C', label: 'Tela Y', code: '111', swatchImageId: 'sw-C' },
          { grade: 'D', label: 'Cuero Z', code: '222', swatchImageId: 'sw-D' },
        ],
      },
    },
    {
      id: 'cmp', name: 'Modular', components: [
        {
          id: 'c1', name: 'Chaise', reference: '87654321A', subtype: 'Grade A — Tela X',
          unitPrice: 200, qty: 1, swatchImageId: 'sw-cA',
          materialOptions: { baseGrade: 'A', baseLabel: 'Tela X', options: [{ grade: 'C', label: 'Tela Y', swatchImageId: 'sw-cC' }] },
        },
        { id: 'c2', name: 'Otomana', unitPrice: 75, qty: 1, isOptional: true, optionalOffered: true },
        { id: 'c3', name: 'Garantía', unitPrice: 20, qty: 1, isOptional: true },
        { id: 'p', alternativeGroup: 'cg', isSelectedAlternative: true, name: 'Tela', unitPrice: 100, qty: 1 },
        { id: 'q', alternativeGroup: 'cg', isSelectedAlternative: false, name: 'Cuero', unitPrice: 200, qty: 1 },
      ],
    },
  ];
}

// Catalog: root → GRADE(uppercase) → { price, cost }. Deltas in the bundle equal
// (grade price − base price), so client `unit + delta` === server catalog price.
function priceMap() {
  return new Map([
    ['12345678', new Map([['A', { price: 100, cost: 40 }], ['C', { price: 150, cost: 60 }], ['D', { price: 190, cost: 75 }]])],
    ['87654321', new Map([['A', { price: 200, cost: 80 }], ['C', { price: 230, cost: 92 }]])],
  ]);
}

// Apply the server reducer's patches onto a copy of the rows — what the shell's
// per-line UPDATE does — so we can read the resulting row.
function applyServerPatches(rows, patches) {
  return rows.map((r) => (patches.has(r.id) ? { ...r, ...patches.get(r.id) } : r));
}
const cl = (b, id) => b.lines.find((l) => l.id === id);
const sl = (rows, id) => rows.find((r) => r.id === id);
const ccomp = (b, lineId, compId) => cl(b, lineId).components.find((c) => c.id === compId);
const scomp = (rows, lineId, compId) => sl(rows, lineId).components.find((c) => c.id === compId);

// Run a pick through both reducers; return { client bundle, server rows-after }.
function both(pick) {
  const client = applyClientPick(clientBundle(), pick);
  const patches = applyPicks(serverRows(), pick, priceMap());
  const server = applyServerPatches(serverRows(), patches);
  return { client, server };
}

// ── The shared rules ────────────────────────────────────────────────────────

test('parity — line alternative: same member ends selected', () => {
  const { client, server } = both({ alternatives: { g1: 'b' } });
  assert.equal(cl(client, 'a').isSelectedAlternative, sl(server, 'a').is_selected_alternative);
  assert.equal(cl(client, 'b').isSelectedAlternative, sl(server, 'b').is_selected_alternative);
  assert.equal(sl(server, 'b').is_selected_alternative, true);
});

test('parity — line optional toggles in, and back out', () => {
  for (const on of [true, false]) {
    const { client, server } = both({ optionals: { opt: on } });
    assert.equal(cl(client, 'opt').isOptional, sl(server, 'opt').is_optional);
    assert.equal(sl(server, 'opt').is_optional, !on);
  }
});

test('parity — a non-offered line optional is untouched by both', () => {
  const { client, server } = both({ optionals: { optLocked: true } });
  assert.equal(cl(client, 'optLocked').isOptional, true);
  assert.equal(sl(server, 'optLocked').is_optional, true);
});

test('parity — line material: same unit, subtype, reference, swatch, baseGrade; range cleared', () => {
  const { client, server } = both({ materials: { m: 'C' } });
  const c = cl(client, 'm');
  const s = sl(server, 'm');
  assert.equal(c.unitPrice, s.unit_price);                 // 150 both
  assert.equal(c.unitPrice, 150);
  assert.equal(c.subtype, s.subtype);                      // 'Grade C — Tela Y'
  assert.equal(c.reference, s.reference);                  // '12345678C'
  assert.equal(c.swatchImageId, s.swatch_image_id);        // 'sw-C'
  assert.equal(c.materialOptions.baseGrade, s.material_options.baseGrade);   // 'C'
  assert.equal(c.materialOptions.baseLabel, s.material_options.baseLabel);   // 'Tela Y'
  // Picking a material pins the price → range dropped on both sides.
  assert.equal(c.priceMin ?? null, null);
  assert.equal(c.priceMax ?? null, null);
  assert.equal(s.price_min, null);
  assert.equal(s.price_max, null);
});

test('parity — an unoffered grade is rejected by both', () => {
  const { client, server } = both({ materials: { m: 'Z' } });
  assert.equal(cl(client, 'm').unitPrice, 100);
  assert.equal(sl(server, 'm').unit_price, 100);
  assert.equal(cl(client, 'm').reference, '12345678A');
  assert.equal(sl(server, 'm').reference, '12345678A');
});

test('parity — component material: switches the right sub-piece identically', () => {
  const { client, server } = both({ materials: { c1: 'C' } });
  const c = ccomp(client, 'cmp', 'c1');
  const s = scomp(server, 'cmp', 'c1');
  assert.equal(c.unitPrice, s.unitPrice);                  // 230 both
  assert.equal(c.unitPrice, 230);
  assert.equal(c.subtype, s.subtype);
  assert.equal(c.reference, s.reference);                  // '87654321C'
  assert.equal(c.swatchImageId, s.swatchImageId);          // 'sw-cC'
  assert.equal(c.materialOptions.baseGrade, s.materialOptions.baseGrade);
  // siblings untouched on both
  assert.equal(ccomp(client, 'cmp', 'c2').unitPrice, scomp(server, 'cmp', 'c2').unitPrice);
});

test('parity — component optional toggles identically', () => {
  for (const on of [true, false]) {
    const { client, server } = both({ optionals: { c2: on } });
    assert.equal(ccomp(client, 'cmp', 'c2').isOptional, scomp(server, 'cmp', 'c2').isOptional);
    assert.equal(scomp(server, 'cmp', 'c2').isOptional, !on);
  }
});

test('parity — a non-offered component optional is untouched by both', () => {
  const { client, server } = both({ optionals: { c3: true } });
  assert.equal(ccomp(client, 'cmp', 'c3').isOptional, true);
  assert.equal(scomp(server, 'cmp', 'c3').isOptional, true);
});

test('parity — component alternative selects the same sub-piece', () => {
  const { client, server } = both({ alternatives: { cg: 'q' } });
  assert.equal(ccomp(client, 'cmp', 'p').isSelectedAlternative, scomp(server, 'cmp', 'p').isSelectedAlternative);
  assert.equal(ccomp(client, 'cmp', 'q').isSelectedAlternative, scomp(server, 'cmp', 'q').isSelectedAlternative);
  assert.equal(scomp(server, 'cmp', 'q').isSelectedAlternative, true);
});

test('parity — free material pick: any catalog fabric reprices a line by grade', () => {
  const sel = { grade: 'C', fabric: 'Nueva Tela · Azul (#999)', swatchImageId: 'sw-new' };
  const { client, server } = both({ materialPick: { m: sel } });
  const c = cl(client, 'm');
  const s = sl(server, 'm');
  assert.equal(c.unitPrice, s.unit_price);                 // 150 both (grade C)
  assert.equal(c.unitPrice, 150);
  assert.equal(c.subtype, s.subtype);                      // 'Grade C — Nueva Tela · Azul (#999)'
  assert.equal(c.subtype, 'Grade C — Nueva Tela · Azul (#999)');
  assert.equal(c.reference, s.reference);                  // '12345678C'
  assert.equal(c.swatchImageId, s.swatch_image_id);        // 'sw-new'
  assert.equal(c.materialOptions.baseGrade, s.material_options.baseGrade); // 'C'
  assert.equal(c.materialOptions.baseLabel, s.material_options.baseLabel); // the new fabric
  // Picking a material pins the price → range dropped on both sides.
  assert.equal(c.priceMin ?? null, null);
  assert.equal(s.price_min, null);
});

test('parity — free material pick on a grade with no SKU is rejected by both', () => {
  const { client, server } = both({ materialPick: { m: { grade: 'Z', fabric: 'Inventada' } } });
  assert.equal(cl(client, 'm').unitPrice, 100);
  assert.equal(sl(server, 'm').unit_price, 100);
  assert.equal(cl(client, 'm').reference, '12345678A');
  assert.equal(sl(server, 'm').reference, '12345678A');
});

test('parity — free material pick reprices the right component identically', () => {
  const sel = { grade: 'C', fabric: 'Otra · Gris (#7)', swatchImageId: 'sw-x' };
  const { client, server } = both({ materialPick: { c1: sel } });
  const c = ccomp(client, 'cmp', 'c1');
  const s = scomp(server, 'cmp', 'c1');
  assert.equal(c.unitPrice, s.unitPrice);                  // 230 both
  assert.equal(c.unitPrice, 230);
  assert.equal(c.subtype, s.subtype);
  assert.equal(c.reference, s.reference);                  // '87654321C'
  assert.equal(c.swatchImageId, s.swatchImageId);          // 'sw-x'
  // sibling untouched on both
  assert.equal(ccomp(client, 'cmp', 'c2').unitPrice, scomp(server, 'cmp', 'c2').unitPrice);
});

test('parity — composed picks (alt + optional + material) agree across the wall', () => {
  const pick = { alternatives: { g1: 'b' }, optionals: { opt: true, c2: true }, materials: { m: 'C', c1: 'C' } };
  const { client, server } = both(pick);
  assert.equal(cl(client, 'b').isSelectedAlternative, sl(server, 'b').is_selected_alternative);
  assert.equal(cl(client, 'opt').isOptional, sl(server, 'opt').is_optional);
  assert.equal(cl(client, 'm').unitPrice, sl(server, 'm').unit_price);
  assert.equal(ccomp(client, 'cmp', 'c2').isOptional, scomp(server, 'cmp', 'c2').isOptional);
  assert.equal(ccomp(client, 'cmp', 'c1').unitPrice, scomp(server, 'cmp', 'c1').unitPrice);
});
