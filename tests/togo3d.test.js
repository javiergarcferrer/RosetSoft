// Togo 3D preview — pins the PURE pieces (no three.js): the procedural geometry
// (inferTogoForm + togoParts) and the scene projection (resolveTogoScene), so the
// 3D mass matches the 2D plan: pieces are sized to their real footprints, sit on
// the floor, stay inside their footprint AABB, and the layout is recentred on the
// origin with the right overall size.
import test from 'node:test';
import assert from 'node:assert/strict';

import { inferTogoForm, inferTogoKind, togoParts, TOGO_HEIGHT_CM } from '../src/lib/togo/togoModel.js';
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

test('togoParts builds a floor-standing, footprint-bounded, cohesive body', () => {
  const W = 174, D = 102;
  const parts = togoParts(W, D, { armCount: 2 });
  assert.ok(parts.length >= 3, 'seat + back + 2 arms');
  assert.equal(parts.filter((p) => p.role === 'arm').length, 2);
  assert.equal(parts.filter((p) => p.role === 'seat').length, 1);

  let maxY = 0;
  for (const p of parts) {
    // Every part sits on/above the floor (Togo is legless) …
    assert.ok(p.y - p.h / 2 >= -0.01, `${p.role} dips below the floor`);
    // … and stays within the footprint AABB (the 3D mass = the 2D tile).
    assert.ok(p.x - p.w / 2 >= -W / 2 - 0.5 && p.x + p.w / 2 <= W / 2 + 0.5, `${p.role} exceeds width`);
    assert.ok(p.z - p.d / 2 >= -D / 2 - 0.5 && p.z + p.d / 2 <= D / 2 + 0.5, `${p.role} exceeds depth`);
    assert.ok(p.r > 0, 'parts are rounded (puffy)');
    maxY = Math.max(maxY, p.y + p.h / 2);
  }
  assert.ok(Math.abs(maxY - TOGO_HEIGHT_CM) < 1, 'the backrest reaches the Togo height');

  // Armless (chauffeuse) drops the arm parts; chaise keeps one.
  assert.equal(togoParts(87, 102, { armCount: 0 }).filter((p) => p.role === 'arm').length, 0);
  const chaise = togoParts(131, 162, { armCount: 1 });
  assert.equal(chaise.filter((p) => p.role === 'arm').length, 1);
  // Single-arm pieces must ALSO stay inside the footprint (the backrest tuck-
  // behind once overflowed the armed side) — the 3D mass matches the 2D tile.
  for (const p of chaise) {
    assert.ok(p.x - p.w / 2 >= -131 / 2 - 0.5 && p.x + p.w / 2 <= 131 / 2 + 0.5, `${p.role} exceeds width`);
    assert.ok(p.z - p.d / 2 >= -162 / 2 - 0.5 && p.z + p.d / 2 <= 162 / 2 + 0.5, `${p.role} exceeds depth`);
  }
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
