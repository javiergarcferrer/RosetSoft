// Togo 3D preview — pins the PURE pieces (no three.js): the procedural geometry
// (inferTogoForm + togoParts) and the scene projection (resolveTogoScene), so the
// 3D mass matches the 2D plan: pieces are sized to their real footprints, sit on
// the floor, stay inside their footprint AABB, and the layout is recentred on the
// origin with the right overall size.
import test from 'node:test';
import assert from 'node:assert/strict';

import { inferTogoForm, inferTogoKind, togoParts, togoMeshFit, TOGO_HEIGHT_CM } from '../src/lib/togo/togoModel.js';
import { glbFor, hasTogoGlb } from '../src/assets/togo/togoModels3d.js';
import { resolveTogoScene } from '../src/core/quote/views/configuratorView.js';

test('inferTogoForm reads arms from the label, then the footprint shape', () => {
  assert.equal(inferTogoForm('Chofesa Togo').armCount, 0);        // fireside / no arms
  assert.equal(inferTogoForm('Togo chauffeuse').armCount, 0);
  assert.equal(inferTogoForm('Meridiana Togo').armCount, 1);      // chaise → one arm
  assert.equal(inferTogoForm('Sofá Togo').armCount, 2);           // settee → two arms
  assert.equal(inferTogoForm('Sillón Togo').armCount, 2);
  // A deep, narrow footprint reads as a chaise even with a neutral label.
  assert.equal(inferTogoForm('Pieza', 100, 160).armCount, 1);
  assert.equal(inferTogoForm('Pieza', 174, 102).armCount, 2);
});

// AABB half-extents per part shape (box: w/h/d; ridge capsule: length along its
// axis + radius caps, radius on the other two axes).
function aabb(p) {
  if (p.shape === 'ridge') {
    const ex = p.axis === 'x' ? p.length / 2 + p.radius : p.radius;
    const ez = p.axis === 'z' ? p.length / 2 + p.radius : p.radius;
    return { x0: p.x - ex, x1: p.x + ex, y0: p.y - p.radius, y1: p.y + p.radius, z0: p.z - ez, z1: p.z + ez };
  }
  return { x0: p.x - p.w / 2, x1: p.x + p.w / 2, y0: p.y - p.h / 2, y1: p.y + p.h / 2, z0: p.z - p.d / 2, z1: p.z + p.d / 2 };
}

test('togoParts builds a floor-standing, channeled Togo within its footprint', () => {
  const W = 174, D = 102;
  const parts = togoParts(W, D, { armCount: 2 });
  const cores = parts.filter((p) => p.shape === 'box');
  assert.equal(cores.filter((p) => p.role === 'seat').length, 1);
  assert.equal(cores.filter((p) => p.role === 'arm').length, 2);
  assert.ok(parts.some((p) => p.shape === 'ridge'), 'has the channel ridges');

  let maxY = 0;
  for (const p of parts) {
    const b = aabb(p);
    maxY = Math.max(maxY, b.y1);
    assert.ok(b.y0 >= -0.5, `${p.role} dips below the floor`);
  }
  assert.ok(Math.abs(maxY - TOGO_HEIGHT_CM) <= 8, 'reaches ~the Togo height');

  // The CORE mass stays inside the footprint tile (ridges may plush-overhang).
  const inFootprint = (list, w, d) => list.filter((p) => p.shape === 'box').forEach((p) => {
    const b = aabb(p);
    assert.ok(b.x0 >= -w / 2 - 0.5 && b.x1 <= w / 2 + 0.5, `${p.role} core exceeds width`);
    assert.ok(b.z0 >= -d / 2 - 0.5 && b.z1 <= d / 2 + 0.5, `${p.role} core exceeds depth`);
  });
  inFootprint(parts, W, D);

  // Armless (chauffeuse) drops the arms; chaise keeps one and still fits (the
  // single-arm backrest tuck-behind once overflowed the armed side).
  assert.equal(togoParts(87, 102, { armCount: 0 }).filter((p) => p.role === 'arm' && p.shape === 'box').length, 0);
  const chaise = togoParts(131, 162, { armCount: 1 });
  assert.equal(chaise.filter((p) => p.role === 'arm' && p.shape === 'box').length, 1);
  inFootprint(chaise, 131, 162);
});

test('inferTogoKind maps to a canonical Togo piece (label, then footprint), for GLB lookup', () => {
  assert.equal(inferTogoKind('Chofesa Togo'), 'chauf');
  assert.equal(inferTogoKind('Sofá grande Togo'), 'mc');
  assert.equal(inferTogoKind('Meridiana Togo'), 'lounge');
  // No keyword → nearest measured footprint (174×102 == the settee gb).
  assert.equal(inferTogoKind('Pieza', 174, 102), 'gb');
  assert.equal(inferTogoKind('', 0, 0), null);
});

test('the GLB manifest is empty until real models are exported (procedural fallback)', () => {
  // No assets wired yet → every kind resolves to null, so the viewer draws
  // procedural geometry. When a real Togo GLB is added this flips on with no
  // other code change.
  assert.equal(hasTogoGlb(), false);
  assert.equal(glbFor('a'), null);
  assert.equal(glbFor(null), null);
});

test('resolveTogoScene recentres the layout on the origin with the right overall size', () => {
  // Two settees side by side in the plan (cm, y-down, top-left origin).
  const scene = resolveTogoScene([
    { x: 0, y: 0, rot: 0, widthCm: 174, depthCm: 102, label: 'Sofá Togo', fabricCode: '4479' },
    { x: 174, y: 0, rot: 0, widthCm: 102, depthCm: 102, label: 'Sillón Togo' },
  ]);
  assert.equal(scene.count, 2);
  assert.deepEqual(scene.overallCm, { widthCm: 276, depthCm: 102 });
  // Centred on the origin: the two piece centres straddle x=0.
  const xs = scene.pieces.map((p) => p.x);
  assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > 0, 'layout is centred on origin');
  assert.equal(scene.pieces[0].form.armCount, 2);
  assert.equal(scene.pieces[1].form.armCount, 2);
  assert.equal(scene.pieces[0].fabricCode, '4479');

  // A 90° rotation swaps the footprint used for centring/overall size.
  const rotated = resolveTogoScene([{ x: 0, y: 0, rot: 90, widthCm: 174, depthCm: 102, label: 'Sofá' }]);
  assert.deepEqual(rotated.overallCm, { widthCm: 102, depthCm: 174 });
  assert.equal(rotated.pieces[0].rotationDeg, 90);

  // Empty plan → safe zeros, never NaN.
  assert.deepEqual(resolveTogoScene([]).overallCm, { widthCm: 0, depthCm: 0 });
});

test('togoMeshFit pins 2D↔3D parity: an uploaded mesh fills its plan tile at the Togo height', () => {
  // A settee mesh measured 174(W)×72(H)×102(D) onto a 174×102 tile → identity,
  // so a correctly-proportioned model is NOT distorted.
  let f = togoMeshFit({ x: 174, y: 72, z: 102 }, 174, 102, 72);
  assert.ok(Math.abs(f.sx - 1) < 1e-6 && Math.abs(f.sy - 1) < 1e-6 && Math.abs(f.sz - 1) < 1e-6);

  // The footprint lands EXACTLY on the tile (the location fix): a mesh 0.5×/2×
  // off in plan still ends up widthCm×depthCm so its edges line up with the plan.
  f = togoMeshFit({ x: 87, y: 72, z: 204 }, 174, 102, 72);
  assert.ok(Math.abs(f.sx * 87 - 174) < 1e-6 && Math.abs(f.sz * 204 - 102) < 1e-6);

  // Height ALWAYS normalises to the Togo height — every uploaded piece, any
  // footprint, comes out the same height (the bug where settees towered).
  f = togoMeshFit({ x: 200, y: 50, z: 100 }, 174, 102, 72);
  assert.ok(Math.abs(f.sy * 50 - 72) < 1e-6, 'height → 72 regardless of footprint');

  // A mesh authored in METRES (0.01×) still fits — it's a ratio, units cancel.
  f = togoMeshFit({ x: 1.74, y: 0.72, z: 1.02 }, 174, 102, 72);
  assert.ok(Math.abs(f.sx * 1.74 - 174) < 1e-4 && Math.abs(f.sz * 1.02 - 102) < 1e-4);

  // No footprint (untracked) → uniform scale by height, never NaN.
  f = togoMeshFit({ x: 80, y: 36, z: 80 }, 0, 0, 72);
  assert.ok(Math.abs(f.sx - f.sy) < 1e-9 && Math.abs(f.sy - f.sz) < 1e-9 && Math.abs(f.sy * 36 - 72) < 1e-6);
});
