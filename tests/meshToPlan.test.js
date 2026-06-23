import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshPlanFromTriangles } from '../src/lib/togo/meshToPlan.js';

// Two triangles covering an axis-aligned rectangle [x0,x0+w] × [z0,z0+d].
const rect = (x0, z0, w, d) => [
  x0, z0, x0 + w, z0, x0 + w, z0 + d,
  x0, z0, x0 + w, z0 + d, x0, z0 + d,
];
const loopsOf = (d) => (d.match(/M/g) || []).length;
const vertsOf = (d) => (d.match(/[ML]/g) || []).length;

test('rectangle → viewBox is the footprint, one 4-point loop', () => {
  // Offset origin to prove the bbox is normalised to 0,0.
  const res = meshPlanFromTriangles(rect(10, 20, 100, 60));
  assert.equal(res.widthCm, 100);
  assert.equal(res.depthCm, 60);
  assert.match(res.svg, /viewBox="0 0 100 60"/);
  assert.match(res.svg, /stroke="currentColor"/);
  assert.equal(loopsOf(res.svg), 1, 'a solid rectangle is a single loop');
  assert.ok(res.svg.trim().endsWith('Z"/></svg>'), 'loop is closed');
  const v = vertsOf(res.svg);
  assert.ok(v >= 4 && v <= 6, `rectangle simplifies to ~4 corners, got ${v}`);
});

test('non-square corner footprint maps straight to the viewBox', () => {
  const res = meshPlanFromTriangles(rect(0, 0, 105, 130));
  assert.equal(res.widthCm, 105);
  assert.equal(res.depthCm, 130);
  assert.match(res.svg, /viewBox="0 0 105 130"/);
});

test('L-shape → one closed loop with the concavity (more than 4 corners)', () => {
  // Bottom band [0,100]×[50,100] ∪ top-left square [0,50]×[0,50] = an L.
  const tris = [...rect(0, 50, 100, 50), ...rect(0, 0, 50, 50)];
  const res = meshPlanFromTriangles(tris);
  assert.equal(res.widthCm, 100);
  assert.equal(res.depthCm, 100);
  assert.equal(loopsOf(res.svg), 1, 'the L is one connected region');
  const v = vertsOf(res.svg);
  assert.ok(v >= 5 && v <= 9, `an L has ~6 corners, got ${v}`);
  // The removed quadrant (75,25) must NOT be filled: the max-x vertices only
  // reach the lower band, so some boundary vertex sits at x≈50 mid-height.
  assert.ok(/L?50(\.\d+)? /.test(res.svg) || res.svg.includes('50 '), 'has the inner corner near x=50');
});

test('degenerate input → empty plan, never throws', () => {
  assert.equal(meshPlanFromTriangles([]).svg, '');
  assert.equal(meshPlanFromTriangles([0, 0, 1, 1, 2, 2]).svg, ''); // zero-area triangle
  assert.equal(meshPlanFromTriangles(null).svg, '');
});
