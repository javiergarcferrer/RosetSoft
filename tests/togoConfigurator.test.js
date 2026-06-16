// Togo configurator — pins the asset footprints, the plan math (rotation +
// snapping), and the load-bearing invariant: a placed layout is a NORMAL modular
// quote line, so the configurator's subtotal IS the pricing engine's
// `compoundSubtotal`. If that parity ever breaks, screen ≠ quote — fail loudly.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  footprintOf, snapPlacement, clampToPlan, resolvePlacement,
  buildTogoComponents, buildTogoModularSeed, resolveConfigurator, resolveTogoModels,
} from '../src/core/quote/views/configuratorView.js';
import { compoundSubtotal } from '../src/lib/pricing.js';
import { modulesOf, isModularLine } from '../src/lib/modules.js';
import { isPricedComponent } from '../src/lib/constants.js';
import { TOGO_PIECES } from '../src/assets/togo/pieces.js';

// A deterministic id factory (the app passes db.newId).
const ids = () => { let i = 0; return () => `id${i++}`; };

// The five Togo footprints MEASURED from the DWG "Mobilier 2D" layer. Pinning
// them guards a bad asset re-generation (wrong layer, wrong units, broken parse).
const EXPECTED = {
  chauf: [87, 102], a: [102, 102], gb: [174, 102], mc: [198, 102], lounge: [131, 162],
};

test('the generated Togo manifest carries the measured cm footprints', () => {
  assert.equal(TOGO_PIECES.length, 5);
  for (const p of TOGO_PIECES) {
    assert.ok(EXPECTED[p.id], `unexpected piece id ${p.id}`);
    assert.deepEqual([p.widthCm, p.depthCm], EXPECTED[p.id], `footprint drift on ${p.id}`);
    assert.ok(p.svgFile && /\.svg$/.test(p.svgFile), `${p.id} missing svgFile`);
    assert.ok(Array.isArray(p.match) && p.match.includes('togo'), `${p.id} missing match keywords`);
  }
});

test('footprintOf swaps width/depth at 90° and 270°, not at 0°/180°', () => {
  const piece = { widthCm: 174, depthCm: 102 };
  assert.deepEqual(footprintOf(piece, 0), { w: 174, h: 102 });
  assert.deepEqual(footprintOf(piece, 180), { w: 174, h: 102 });
  assert.deepEqual(footprintOf(piece, 90), { w: 102, h: 174 });
  assert.deepEqual(footprintOf(piece, 270), { w: 102, h: 174 });
  assert.deepEqual(footprintOf(piece, -90), { w: 102, h: 174 }); // normalises
});

test('snapPlacement rounds to the grid and clicks flush to a neighbour edge', () => {
  // Grid rounding with no neighbours.
  assert.deepEqual(snapPlacement({ x: 101, y: 51, w: 50, h: 50 }, []), { x: 102, y: 52 });

  // A piece nudged just past a settee's right edge (shared 102 cm depth band)
  // snaps flush: its left edge lands exactly on the settee's right edge.
  const settee = { x: 0, y: 0, w: 174, h: 102 };
  const snapped = snapPlacement({ x: 170, y: 3, w: 102, h: 102 }, [settee]);
  assert.equal(snapped.x, 174, 'left edge should meet the settee right edge');
  assert.equal(snapped.y, 0, 'tops should align');

  // Out of range → no snap, just the grid round.
  const far = snapPlacement({ x: 400, y: 300, w: 102, h: 102 }, [settee]);
  assert.deepEqual(far, { x: 400, y: 300 });
});

test('clampToPlan keeps the whole footprint inside the plan', () => {
  assert.deepEqual(clampToPlan(-20, -5, 100, 100, 760, 540), { x: 0, y: 0 });
  assert.deepEqual(clampToPlan(900, 900, 100, 100, 760, 540), { x: 660, y: 440 });
});

// ---- the parity that matters: layout → a real modular line ----
const resolved = {
  a: { id: 'a', label: 'Sillón', name: 'Togo Armchair', reference: '15420000A', subtype: 'A', widthCm: 102, depthCm: 102, unitPrice: 1200, dimensions: '102×102 cm' },
  gb: { id: 'gb', label: 'Sofá', name: 'Togo Settee', reference: '15430000A', subtype: 'A', widthCm: 174, depthCm: 102, unitPrice: 2600, dimensions: '174×102 cm' },
};
const placed = [
  { uid: 'u1', pieceId: 'a', x: 0, y: 0, rot: 0 },
  { uid: 'u2', pieceId: 'gb', x: 0, y: 110, rot: 90 },
  { uid: 'u3', pieceId: 'a', x: 110, y: 0, rot: 0 },
];

test('placed pieces build a MODULAR line whose subtotal === compoundSubtotal', () => {
  const seed = buildTogoModularSeed(placed, resolved, ids());
  assert.equal(seed.family, 'Togo');
  assert.equal(seed.components.length, 3);

  const line = { components: seed.components };
  // Each placed piece is its OWN module (a Togo "complete element").
  assert.ok(isModularLine(line), 'a per-component moduleGroup must read as modular');
  assert.equal(modulesOf(seed.components).length, 3, 'one module per placed piece');

  // Every component is priced (no optionals/alternatives) and carries its plan.
  for (const c of seed.components) {
    assert.ok(isPricedComponent(c), 'a configured piece must count toward the total');
    assert.ok(c.moduleGroup, 'each piece needs its own module group');
    assert.ok(c.plan && Number.isFinite(c.plan.x) && Number.isFinite(c.plan.y), 'plan geometry rides on the component');
  }

  // The engine the editor/PDF/bridge use agrees with our sum, to the cent.
  const expected = 1200 + 2600 + 1200;
  assert.equal(compoundSubtotal(line), expected);
});

test('a per-placement material overrides price/subtype/swatch and flows into the total', () => {
  const r = { a: { id: 'a', label: 'A', widthCm: 102, depthCm: 102, unitPrice: 1000, subtype: 'A', reference: '15420000A' } };
  const withMat = [
    { uid: 'u1', pieceId: 'a', x: 0, y: 0, rot: 0 },
    { uid: 'u2', pieceId: 'a', x: 0, y: 110, rot: 0, material: { unitPrice: 1500, subtype: 'G · ALCANTARA', swatchImageId: 'img-9', reference: '15420000G', fabric: 'ALCANTARA', grade: 'G' } },
  ];
  // resolvePlacement overlays the material onto the model defaults.
  assert.equal(resolvePlacement(withMat[0], r).unitPrice, 1000);
  assert.equal(resolvePlacement(withMat[1], r).unitPrice, 1500);

  const comps = buildTogoComponents(withMat, r, ids());
  assert.equal(comps[0].unitPrice, 1000);
  assert.equal(comps[1].unitPrice, 1500);
  assert.equal(comps[1].subtype, 'G · ALCANTARA');
  assert.equal(comps[1].swatchImageId, 'img-9');
  assert.equal(comps[1].reference, '15420000G');
  // The repriced fabric lands in the engine's compound total.
  assert.equal(compoundSubtotal({ components: comps }), 2500);
});

test('module groups are unique per piece, and rotation rides on the plan', () => {
  const comps = buildTogoComponents(placed, resolved, ids());
  const groups = new Set(comps.map((c) => c.moduleGroup));
  assert.equal(groups.size, comps.length, 'module groups must not collide');
  assert.equal(comps[1].plan.rot, 90, 'the settee was placed rotated 90°');
  assert.equal(comps[1].plan.pieceId, 'gb');
});

// ---- the palette projection shared by the builder + the Solicitudes inbox ----
test('resolveTogoModels prices each model at its cheapest grade, drops inactive/empty', () => {
  const products = [
    { reference: '15420000A', name: 'Togo Armchair', priceUsd: 1200, brand: 'ligne-roset', dimensions: '102×102 cm' },
    { reference: '15420000G', name: 'Togo Armchair', priceUsd: 1500, brand: 'ligne-roset' },
  ];
  const models = [
    { id: 'm1', name: 'Sillón Togo', productRoot: '15420000', widthCm: 102, depthCm: 102, svg: '<svg/>', active: true, sortOrder: 1 },
    { id: 'm2', name: 'Sin vincular', productRoot: null, widthCm: 87, depthCm: 102, svg: '<svg/>', active: true, sortOrder: 0 },
    { id: 'm3', name: 'Inactivo', productRoot: '15420000', widthCm: 0, depthCm: 0, svg: '<svg/>', active: false, sortOrder: 2 },
    { id: 'm4', name: 'Sin dibujo', productRoot: null, widthCm: 1, depthCm: 1, svg: '', active: true, sortOrder: 3 },
  ];
  const { activeModels, resolvedById, svgById } = resolveTogoModels(models, products);

  // Inactive + svg-less models are dropped; the rest sort by sortOrder.
  assert.deepEqual(activeModels.map((m) => m.id), ['m2', 'm1']);
  assert.equal(svgById.m1, '<svg/>');
  assert.equal(svgById.m3, undefined);

  // A bound model prices at its CHEAPEST grade (A=1200, not G=1500).
  assert.equal(resolvedById.m1.unitPrice, 1200);
  assert.equal(resolvedById.m1.reference, '15420000A');
  // An unbound model has no price; dimensions fall back to its footprint.
  assert.equal(resolvedById.m2.unitPrice, null);
  assert.equal(resolvedById.m2.dimensions, '87×102 cm');

  // A request's placements replay through the SAME resolved palette → real total.
  const placed = [{ uid: 'u1', pieceId: 'm1', x: 0, y: 0, rot: 0 }];
  assert.equal(resolveConfigurator(placed, resolvedById, { scale: 1 }).subtotalUsd, 1200);
});

test('resolveConfigurator mirrors compoundSubtotal and lays tiles out in px', () => {
  const vm = resolveConfigurator(placed, resolved, { scale: 1 });
  assert.equal(vm.count, 3);
  assert.equal(vm.subtotalUsd, compoundSubtotal({ components: buildTogoComponents(placed, resolved, ids()) }));
  assert.equal(vm.subtotalUsd, 5000);
  assert.ok(vm.priced, 'all three pieces are priced');

  // The rotated settee tile (gb @ 90°) has a swapped footprint: 102 wide × 174 tall.
  const gbTile = vm.tiles.find((t) => t.uid === 'u2');
  assert.equal(gbTile.wPx, 102);
  assert.equal(gbTile.hPx, 174);
  // The svg inner box stays the UNrotated size (it rotates inside the tile).
  assert.equal(gbTile.innerWPx, 174);
  assert.equal(gbTile.innerHPx, 102);

  // An unpriced piece flips `priced` false.
  const vm2 = resolveConfigurator(
    [{ uid: 'x', pieceId: 'a', x: 0, y: 0, rot: 0 }],
    { a: { ...resolved.a, unitPrice: null } },
    { scale: 1 },
  );
  assert.equal(vm2.priced, false);
  assert.equal(vm2.subtotalUsd, 0);
});
