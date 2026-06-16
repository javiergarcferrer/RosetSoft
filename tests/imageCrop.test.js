// Pins the Instagram crop geometry that powers the composer's image cropper.
// The dealer frames a photo to an IG ratio and what they see must be what
// publishes — so the cover/clamp/zoom math (which decides exactly which source
// pixels survive the crop) is pinned here. A regression would silently shift
// what Instagram shows vs. what the cropper previewed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseCropSize, cropWindow, outputSize, ratiosForMode, defaultRatio, ratioById,
  clamp, RATIO_PORTRAIT, RATIO_SQUARE, RATIO_STORY, FEED_RATIOS, MAX_ZOOM,
  panoramaFrameAspect, sliceWindows, clampSlices, TILE_RATIOS,
  MIN_SLICES, MAX_SLICES,
} from '../src/lib/imageCrop.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('baseCropSize covers the frame — wider image keeps full height, trims sides', () => {
  // 2000×1000 image (aspect 2.0) into a portrait 4:5 (=0.8) frame: image is
  // WIDER than the target, so the crop keeps the full 1000px height and the
  // width narrows to 1000*0.8 = 800 (the sides get trimmed).
  const { w, h } = baseCropSize(2000, 1000, 0.8);
  assert.ok(close(w, 800), `w=${w}`);
  assert.ok(close(h, 1000), `h=${h}`);
  assert.ok(close(w / h, 0.8), 'aspect preserved');
});

test('baseCropSize — taller image keeps full width, trims top/bottom', () => {
  // 1000×2000 image (aspect 0.5) into a square 1:1 frame: image is TALLER than
  // the target, so it keeps the full 1000px width; height drops to 1000.
  const { w, h } = baseCropSize(1000, 2000, 1);
  assert.ok(close(w, 1000), `w=${w}`);
  assert.ok(close(h, 1000), `h=${h}`);
});

test('cropWindow at zoom 1 is centered and covers the whole short axis', () => {
  // 4000×3000 into 1:1 → 3000×3000 centered: 500px trimmed off each side.
  const c = cropWindow(4000, 3000, 1, 1, 2000, 1500);
  assert.ok(close(c.sw, 3000) && close(c.sh, 3000), `${c.sw}×${c.sh}`);
  assert.ok(close(c.sx, 500) && close(c.sy, 0), `sx=${c.sx} sy=${c.sy}`);
  assert.ok(close(c.cx, 2000) && close(c.cy, 1500), 'center untouched when in range');
});

test('cropWindow zoom shrinks the window around the center', () => {
  const c = cropWindow(4000, 3000, 1, 2, 2000, 1500);
  assert.ok(close(c.sw, 1500) && close(c.sh, 1500), `${c.sw}×${c.sh}`); // half of 3000
  assert.ok(close(c.sx, 1250) && close(c.sy, 750), `sx=${c.sx} sy=${c.sy}`); // still centered
});

test('cropWindow clamps the center so the window never leaves the image', () => {
  // Pan hard to the top-left past the edge: the window pins to (0,0), never
  // exposing an empty gutter.
  const c = cropWindow(4000, 3000, 1, 1, -9999, -9999);
  assert.ok(close(c.sx, 0) && close(c.sy, 0), `sx=${c.sx} sy=${c.sy}`);
  assert.ok(close(c.cx, 1500) && close(c.cy, 1500), 'center clamped to half-window in');
  // And to the bottom-right past the edge.
  const d = cropWindow(4000, 3000, 1, 1, 99999, 99999);
  assert.ok(close(d.sx, 1000) && close(d.sy, 0), `sx=${d.sx} sy=${d.sy}`); // sx = imgW - sw
});

test('cropWindow clamps zoom into [1, MAX_ZOOM]', () => {
  assert.equal(cropWindow(1000, 1000, 1, 0.2, 500, 500).zoom, 1);
  assert.equal(cropWindow(1000, 1000, 1, 99, 500, 500).zoom, MAX_ZOOM);
});

test('outputSize is 1080 wide at the ratio, never upscaling past the source', () => {
  // Big crop → full 1080 width; portrait 4:5 → 1350 tall.
  const big = outputSize(0.8, 3000);
  assert.deepEqual(big, { w: 1080, h: 1350 });
  // Story 9:16 from a 1080-wide crop → 1920 tall.
  assert.deepEqual(outputSize(9 / 16, 1080), { w: 1080, h: 1920 });
  // Small crop (600px wide) must NOT upscale to 1080.
  const small = outputSize(1, 600);
  assert.deepEqual(small, { w: 600, h: 600 });
});

test('mode → ratio set: story/reel are 9:16-only, feed offers all three', () => {
  assert.deepEqual(ratiosForMode('story'), [RATIO_STORY]);
  assert.deepEqual(ratiosForMode('reel'), [RATIO_STORY]);
  assert.equal(ratiosForMode('feed'), FEED_RATIOS);
  assert.equal(ratiosForMode('carousel'), FEED_RATIOS);
});

test('defaultRatio + ratioById', () => {
  assert.equal(defaultRatio('feed').id, 'portrait');
  assert.equal(defaultRatio('carousel').id, 'portrait');
  assert.equal(defaultRatio('story').id, 'story');
  assert.equal(ratioById('square').aspect, 1);
  assert.equal(ratioById('nope'), RATIO_PORTRAIT); // unknown → portrait fallback
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

// ── Carousel panorama ("sliding feed") ──────────────────────────────────────

test('panoramaFrameAspect — N tiles of aspect a = one window of aspect N·a', () => {
  // 3 portrait (4:5) tiles → frame the band at 3·0.8 = 2.4 (a 12:5 strip).
  assert.ok(close(panoramaFrameAspect(3, 0.8), 2.4), 'portrait×3');
  assert.ok(close(panoramaFrameAspect(4, 1), 4), 'square×4');
  assert.equal(panoramaFrameAspect(2.4, 1), 2); // slice count rounds
});

test('sliceWindows cuts a window into N equal, seam-continuous strips', () => {
  // A 2400×1000 band (aspect 2.4 = 3 portrait tiles) sliced into 3.
  const win = { sx: 100, sy: 50, sw: 2400, sh: 1000 };
  const strips = sliceWindows(win, 3);
  assert.equal(strips.length, 3);
  // Equal width, full band height, shared top.
  for (const s of strips) {
    assert.ok(close(s.sw, 800), `sw=${s.sw}`);
    assert.ok(close(s.sh, 1000) && close(s.sy, 50), `sh=${s.sh} sy=${s.sy}`);
    assert.ok(close(s.sw / s.sh, 0.8), 'each strip is the 4:5 tile ratio');
  }
  // Left→right swipe order, and each strip starts exactly where the last ended
  // (no gap, no overlap → a seamless pan).
  assert.ok(close(strips[0].sx, 100), 'first strip at band left');
  assert.ok(close(strips[1].sx, strips[0].sx + strips[0].sw), 'no seam gap 0→1');
  assert.ok(close(strips[2].sx, strips[1].sx + strips[1].sw), 'no seam gap 1→2');
  // The strips exactly tile the band — last strip ends at the band's right edge.
  assert.ok(close(strips[2].sx + strips[2].sw, win.sx + win.sw), 'strips cover the band');
});

test('panorama round-trips: a framed window slices into exact-ratio IG tiles', () => {
  // A real flow: 4000×1000 panorama, frame 4 square tiles (aspect 4·1 = 4.0).
  // 4000/1000 = 4 = the frame aspect, so the band is the full image; 4 strips.
  const win = cropWindow(4000, 1000, panoramaFrameAspect(4, 1), 1, 2000, 500);
  assert.ok(close(win.sw, 4000) && close(win.sh, 1000), `${win.sw}×${win.sh}`);
  const strips = sliceWindows(win, 4);
  for (const s of strips) {
    const out = outputSize(RATIO_SQUARE.aspect, s.sw);
    assert.deepEqual(out, { w: 1000, h: 1000 }); // 1000px-wide square, not upscaled to 1080
  }
});

test('clampSlices keeps the count in IG range and under the room cap', () => {
  assert.equal(clampSlices(3), 3);
  assert.equal(clampSlices(1), MIN_SLICES); // a panorama needs ≥2
  assert.equal(clampSlices(99), MAX_SLICES); // IG carousel caps at 10
  assert.equal(clampSlices(8, 5), 5); // room of 5 → can't exceed it
  assert.equal(clampSlices(1, 1), MIN_SLICES); // a cap below 2 still yields ≥2
});

test('TILE_RATIOS are the sliding-feed per-tile ratios (portrait + square only)', () => {
  assert.deepEqual(TILE_RATIOS, [RATIO_PORTRAIT, RATIO_SQUARE]);
});
