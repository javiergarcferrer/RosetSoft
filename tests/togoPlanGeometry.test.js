// Pins the PURE plan geometry shared by the build script (seeded assets) AND the
// in-browser DWG uploader — block resolution + transform, plan-layer filtering,
// Y-flip projection, and the merged-path SVG. If this drifts, a dealer-uploaded
// model would render differently from a seeded one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPlan, planToSvg, planFromDb } from '../src/lib/togo/planGeometry.js';

test('planToSvg builds a cm-footprint viewBox and one Y-flipped merged path', () => {
  const polys = [{ pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], closed: true }];
  const { svg, widthCm, depthCm } = planToSvg(polys, []);
  assert.equal(widthCm, 100);
  assert.equal(depthCm, 50);
  assert.match(svg, /viewBox="0 0 100 50"/);
  assert.match(svg, /stroke="currentColor"/);
  // Y is flipped (SVG y-down): world (0,0)→(0,50), (100,0)→(100,50), (100,50)→(100,0).
  assert.ok(svg.includes('d="M0 50L100 50L100 0Z"'), `path was: ${svg}`);
  // Exactly one merged <path>.
  assert.equal((svg.match(/<path /g) || []).length, 1);
});

test('planToSvg on empty geometry yields a blank result (no NaN viewBox)', () => {
  assert.deepEqual(planToSvg([], []), { svg: '', widthCm: 0, depthCm: 0 });
});

test('collectPlan resolves INSERT→block, applies the transform, and filters the layer', () => {
  // A block "B" with one LINE on the plan layer and one LINE on another layer.
  const db = {
    tables: {
      BLOCK_RECORD: {
        entries: [{
          name: 'B',
          basePoint: { x: 0, y: 0 },
          entities: [
            { type: 'LINE', layer: 'Mobilier 2D', startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 } },
            { type: 'LINE', layer: 'Mobilier 3D', startPoint: { x: 0, y: 0 }, endPoint: { x: 99, y: 99 } },
          ],
        }],
      },
    },
    entities: [
      { type: 'INSERT', name: 'B', insertionPoint: { x: 5, y: 5 }, xScale: 1, yScale: 1, rotation: 0 },
    ],
  };
  const { polys } = collectPlan(db, 'Mobilier 2D');
  assert.equal(polys.length, 1, 'only the plan-layer line survives');
  // The block line (0,0)-(10,0) is inserted at (5,5): → (5,5)-(15,5).
  assert.deepEqual(polys[0].pts.map((p) => [p.x, p.y]), [[5, 5], [15, 5]]);

  // layer=null collects every layer (the uploader's fallback).
  assert.equal(collectPlan(db, null).polys.length, 2);

  // planFromDb defaults to the named plan layer and reports the count.
  const plan = planFromDb(db);
  assert.equal(plan.widthCm, 10);
  assert.equal(plan.depthCm, 0);
  assert.equal(plan.polyCount, 1);
});

test('collectPlan applies a 90° insert rotation', () => {
  const db = {
    tables: { BLOCK_RECORD: { entries: [{
      name: 'B', basePoint: { x: 0, y: 0 },
      entities: [{ type: 'LINE', layer: 'Mobilier 2D', startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 } }],
    }] } },
    entities: [{ type: 'INSERT', name: 'B', insertionPoint: { x: 0, y: 0 }, xScale: 1, yScale: 1, rotation: Math.PI / 2 }],
  };
  const { polys } = collectPlan(db, 'Mobilier 2D');
  const [a, b] = polys[0].pts;
  // (0,0) stays; (10,0) rotates 90° CCW → (0,10).
  assert.ok(Math.abs(a.x) < 1e-9 && Math.abs(a.y) < 1e-9);
  assert.ok(Math.abs(b.x) < 1e-9 && Math.abs(b.y - 10) < 1e-9, `got (${b.x}, ${b.y})`);
});
