/**
 * Tests for src/core/jarvis/imageStudio.js — the DALL·E 3 Image Studio VM.
 *
 * Pins the math the View depends on: nearest-native-aspect selection, the
 * center-crop plan (output ALWAYS exactly the target dims), the validation
 * gate (prompt required, count + dim clamps, aspect choice) and the history
 * gallery ordering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DALLE_SIZES,
  nearestDalleAspect,
  cropPlan,
  buildGenerationPlan,
  resolveImageStudio,
} from '../src/core/jarvis/imageStudio.js';

test('nearestDalleAspect maps representative target ratios to native aspects', () => {
  assert.equal(nearestDalleAspect(1080, 1080), 'square'); // 1:1
  assert.equal(nearestDalleAspect(1080, 1920), 'portrait'); // 9:16 story
  assert.equal(nearestDalleAspect(1200, 628), 'landscape'); // FB ad
  assert.equal(nearestDalleAspect(1792, 1024), 'landscape'); // exact native
  // Degenerate input falls back to square (never throws).
  assert.equal(nearestDalleAspect(0, 0), 'square');
});

test('nearestDalleAspect ties resolve to square', () => {
  // A perfectly square target is closest to square; nothing ties it out.
  assert.equal(nearestDalleAspect(500, 500), 'square');
});

test('cropPlan center-crops a wider target and resizes to EXACT target dims', () => {
  // Native landscape 1792x1024, target wider (1200x500 → ratio 2.4 > 1.75).
  const plan = cropPlan(1792, 1024, 1200, 500);
  assert.equal(plan.resize.w, 1200);
  assert.equal(plan.resize.h, 500);
  // Full native width kept, height cropped, centered.
  assert.equal(plan.crop.w, 1792);
  assert.ok(Math.abs(plan.crop.h - 1792 / 2.4) < 1e-6);
  assert.equal(plan.crop.x, 0);
  assert.ok(plan.crop.y > 0); // vertically centered crop
  assert.ok(Math.abs(plan.crop.y - (1024 - plan.crop.h) / 2) < 1e-6);
});

test('cropPlan center-crops a taller target and resizes to EXACT target dims', () => {
  // Native portrait 1024x1792, target taller-than-native (600x1400 → 0.4286 < 0.5714).
  const plan = cropPlan(1024, 1792, 600, 1400);
  assert.equal(plan.resize.w, 600);
  assert.equal(plan.resize.h, 1400);
  assert.equal(plan.crop.h, 1792); // full native height
  assert.ok(plan.crop.w < 1024); // narrower crop
  assert.ok(plan.crop.y === 0);
  assert.ok(plan.crop.x > 0); // horizontally centered
  assert.ok(Math.abs(plan.crop.x - (1024 - plan.crop.w) / 2) < 1e-6);
});

test('cropPlan output ratio equals the target ratio', () => {
  const plan = cropPlan(1024, 1024, 1200, 628);
  const cropRatio = plan.crop.w / plan.crop.h;
  assert.ok(Math.abs(cropRatio - 1200 / 628) < 1e-6);
});

test('buildGenerationPlan rejects an empty prompt', () => {
  const r = buildGenerationPlan({ prompt: '   ', count: 2 });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('buildGenerationPlan clamps count to 1..6', () => {
  assert.equal(buildGenerationPlan({ prompt: 'x', count: 0 }).request.count, 1);
  assert.equal(buildGenerationPlan({ prompt: 'x', count: 99 }).request.count, 6);
  assert.equal(buildGenerationPlan({ prompt: 'x', count: 3 }).request.count, 3);
});

test('buildGenerationPlan clamps dims to 256..2048', () => {
  const tiny = buildGenerationPlan({ prompt: 'x', targetWidth: 10, targetHeight: 10 });
  assert.equal(tiny.request.targetWidth, 256);
  assert.equal(tiny.request.targetHeight, 256);
  const huge = buildGenerationPlan({ prompt: 'x', targetWidth: 5000, targetHeight: 5000 });
  assert.equal(huge.request.targetWidth, 2048);
  assert.equal(huge.request.targetHeight, 2048);
});

test('buildGenerationPlan defaults to the square native size when dims omitted', () => {
  const r = buildGenerationPlan({ prompt: 'una sala moderna' });
  assert.equal(r.ok, true);
  assert.equal(r.request.aspect, 'square');
  assert.equal(r.request.targetWidth, DALLE_SIZES.square.w);
  assert.equal(r.request.targetHeight, DALLE_SIZES.square.h);
});

test('buildGenerationPlan selects the aspect from the target dims', () => {
  assert.equal(buildGenerationPlan({ prompt: 'x', targetWidth: 1080, targetHeight: 1920 }).request.aspect, 'portrait');
  assert.equal(buildGenerationPlan({ prompt: 'x', targetWidth: 1200, targetHeight: 628 }).request.aspect, 'landscape');
  assert.equal(buildGenerationPlan({ prompt: 'x', targetWidth: 1080, targetHeight: 1080 }).request.aspect, 'square');
});

test('buildGenerationPlan normalizes quality + style + styleNote', () => {
  const r = buildGenerationPlan({ prompt: 'x', styleNote: '  minimal  ', quality: 'hd', style: 'natural' });
  assert.equal(r.request.quality, 'hd');
  assert.equal(r.request.style, 'natural');
  assert.equal(r.request.styleNote, 'minimal');
  // Unknown values fall back to the defaults.
  const d = buildGenerationPlan({ prompt: 'x', quality: 'wat', style: 'wat' });
  assert.equal(d.request.quality, 'standard');
  assert.equal(d.request.style, 'vivid');
  assert.equal(d.request.styleNote, undefined);
});

test('resolveImageStudio sorts newest-first and groups by day', () => {
  const rows = [
    { id: 'a', prompt: 'older', status: 'completed', createdAt: 1000 },
    { id: 'b', prompt: 'newest', status: 'completed', createdAt: 3000 },
    { id: 'c', prompt: 'mid', status: 'failed', error: 'boom', createdAt: 2000 },
  ];
  const { items, byDay, total } = resolveImageStudio(rows, { now: 5000 });
  assert.deepEqual(items.map((i) => i.id), ['b', 'c', 'a']);
  assert.equal(total, 3);
  assert.equal(items.find((i) => i.id === 'c').statusLabel, 'Falló');
  // All same day → one bucket, items still newest-first inside it.
  assert.equal(byDay.length, 1);
  assert.deepEqual(byDay[0].items.map((i) => i.id), ['b', 'c', 'a']);
});

test('resolveImageStudio is deterministic on createdAt ties (breaks on id)', () => {
  const rows = [
    { id: 'a', prompt: '1', createdAt: 1000 },
    { id: 'b', prompt: '2', createdAt: 1000 },
  ];
  const { items } = resolveImageStudio(rows, { now: 2000 });
  assert.deepEqual(items.map((i) => i.id), ['b', 'a']);
});

test('resolveImageStudio never crashes on empty input', () => {
  const { items, byDay, total } = resolveImageStudio(null);
  assert.deepEqual(items, []);
  assert.deepEqual(byDay, []);
  assert.equal(total, 0);
});
