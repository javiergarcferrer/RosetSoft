// Togo GLB export — pins the PURE-ish AR export contract with a tiny three stub
// (no real WebGL): the configured layout is wrapped in a root scaled cm→m, so AR
// places the sofa TRUE-TO-SCALE; the furniture group carries one node per piece;
// and the swatch loader dedups codes + swallows missing-swatch failures so one
// bad code never blocks the export. The visual three.js path is covered by build.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArGroup, loadFabricTextures } from '../src/components/togo/togoGlbExport.js';
import { resolveTogoScene } from '../src/core/quote/views/configuratorView.js';

// A minimal three.js stand-in — only what buildTogoGroup/makeFabricMaterial touch.
// makeQuiltNormalMap returns null under Node (no `document`), so no CanvasTexture.
function makeThreeStub() {
  class Vector2 { constructor(x, y) { this.x = x; this.y = y; } set(x, y) { this.x = x; this.y = y; return this; } }
  class Color { constructor(v) { this.v = v; } }
  class Group {
    constructor() {
      this.children = []; this.type = 'Group';
      this.position = { set() {} };
      this.rotation = { y: 0 };
      this.scale = { value: 1, setScalar(s) { this.value = s; } };
    }
    add(o) { this.children.push(o); }
    updateMatrixWorld() {}
  }
  class Mesh { constructor(geometry, material) { this.geometry = geometry; this.material = material; this.position = { set() {} }; this.rotation = {}; } }
  class MeshPhysicalMaterial { constructor(o) { Object.assign(this, o); } }
  class CapsuleGeometry { constructor(radius, length) { this.radius = radius; this.length = length; } }
  return {
    Group, Mesh, MeshPhysicalMaterial, CapsuleGeometry, Color, Vector2,
    SRGBColorSpace: 'srgb', RepeatWrapping: 1,
  };
}
class RoundedBoxGeometry { constructor(w, h, d) { this.w = w; this.h = h; this.d = d; } }

test('buildArGroup wraps the furniture in a root scaled cm→m (AR true-to-scale)', () => {
  const THREE = makeThreeStub();
  const scene = resolveTogoScene([
    { x: 0, y: 0, rot: 0, widthCm: 174, depthCm: 102, label: 'Sofá Togo', fabricCode: '4479' },
    { x: 174, y: 0, rot: 0, widthCm: 102, depthCm: 102, label: 'Sillón Togo' },
  ]);
  const { root, quilt, dispose } = buildArGroup({ THREE, RoundedBoxGeometry }, scene, {});

  // The root carries the metre conversion (glTF unit = metre; scene is in cm).
  assert.equal(root.scale.value, 0.01);
  // It wraps exactly the furniture group …
  assert.equal(root.children.length, 1);
  // … which holds one piece-group per placed piece.
  assert.equal(root.children[0].children.length, scene.pieces.length);
  // No CanvasTexture under Node, so there's nothing to bake/dispose — and dispose
  // must be safe to call with no quilt and no textures.
  assert.equal(quilt, null);
  assert.doesNotThrow(() => dispose());
});

test('loadFabricTextures dedups codes and swallows missing swatches', async () => {
  const THREE = {
    TextureLoader: class {
      setCrossOrigin() {}
      loadAsync(url) { return url.includes('bad') ? Promise.reject(new Error('404')) : Promise.resolve({ url }); }
    },
  };
  const map = await loadFabricTextures(THREE, ['a', 'a', 'b', 'bad', '', null], (c) => `https://x/${c}`);
  // 'a' deduped, 'b' kept, 'bad' rejected (swallowed), '' and null filtered out.
  assert.equal(map.size, 2);
  assert.ok(map.has('a') && map.has('b'));
  assert.ok(!map.has('bad'));
});
