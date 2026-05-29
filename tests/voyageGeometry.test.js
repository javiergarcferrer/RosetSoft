/**
 * Tests for src/lib/voyageGeometry.ts — the spherical math behind the
 * container voyage map's curved routes, vessel heading, and progress bar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineKm,
  pathLengthKm,
  bearingDeg,
  greatCircle,
  splitAntimeridian,
  arcThrough,
} from '../src/lib/voyageGeometry.js';

const LE_HAVRE = [49.4861, 0.1056];
const NEW_YORK = [40.7128, -74.0060];
const LONDON = [51.5074, -0.1278];
const PARIS = [48.8566, 2.3522];

test('haversineKm matches known great-circle distances', () => {
  // Le Havre → New York is ~5,800 km.
  assert.ok(Math.abs(haversineKm(LE_HAVRE, NEW_YORK) - 5800) < 150, 'LEH→NYC ≈ 5800 km');
  // London → Paris is ~344 km.
  assert.ok(Math.abs(haversineKm(LONDON, PARIS) - 344) < 20, 'LON→PAR ≈ 344 km');
  // Zero distance for a point to itself.
  assert.equal(haversineKm(PARIS, PARIS), 0);
});

test('bearingDeg gives the cardinal directions', () => {
  assert.ok(Math.abs(bearingDeg([0, 0], [0, 10]) - 90) < 1e-6, 'due east');
  assert.ok(Math.abs(bearingDeg([0, 0], [10, 0]) - 0) < 1e-6, 'due north');
  assert.ok(Math.abs(bearingDeg([0, 0], [0, -10]) - 270) < 1e-6, 'due west');
  assert.ok(Math.abs(bearingDeg([10, 0], [0, 0]) - 180) < 1e-6, 'due south');
});

test('greatCircle keeps endpoints, samples evenly, stays on the equator', () => {
  const pts = greatCircle([0, 0], [0, 90], 18);
  assert.equal(pts.length, 19);                 // segments + 1
  assert.deepEqual(pts[0], [0, 0]);
  assert.ok(Math.abs(pts[18][0]) < 1e-6 && Math.abs(pts[18][1] - 90) < 1e-6);
  // Every sampled point hugs the equator; the midpoint sits at lon 45.
  for (const p of pts) assert.ok(Math.abs(p[0]) < 1e-6, 'lat stays ~0 on the equator');
  assert.ok(Math.abs(pts[9][1] - 45) < 1e-6, 'midpoint at lon 45');
});

test('greatCircle bulges poleward off the equator (a real curve, not a chord)', () => {
  // Two points at 45N: the great circle between them rises above 45N.
  const pts = greatCircle([45, -40], [45, 40], 32);
  const maxLat = Math.max(...pts.map((p) => p[0]));
  assert.ok(maxLat > 45.5, `expected a poleward bulge, got max lat ${maxLat}`);
});

test('splitAntimeridian breaks a path that crosses ±180°', () => {
  const segs = splitAntimeridian([[0, 170], [0, 175], [0, -175], [0, -170]]);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], [[0, 170], [0, 175]]);
  assert.deepEqual(segs[1], [[0, -175], [0, -170]]);
  // A non-crossing path stays whole.
  assert.equal(splitAntimeridian([[0, 0], [0, 10], [0, 20]]).length, 1);
});

test('arcThrough chains legs and reports antimeridian-safe sub-paths', () => {
  // Atlantic hop: one continuous sub-path, perLeg+1 points.
  const atlantic = arcThrough([LE_HAVRE, NEW_YORK], 24);
  assert.equal(atlantic.length, 1);
  assert.equal(atlantic[0].length, 25);

  // A Pacific leg crossing the dateline yields two sub-paths.
  const pacific = arcThrough([[35, 139], [34, -118]], 64); // Tokyo → Los Angeles
  assert.ok(pacific.length >= 2, 'trans-Pacific arc splits at the antimeridian');

  // pathLengthKm of the sampled arc approximates the direct distance.
  const direct = haversineKm(LE_HAVRE, NEW_YORK);
  assert.ok(Math.abs(pathLengthKm(atlantic[0]) - direct) < 5, 'sampled arc ≈ direct GC distance');
});
