/**
 * Togo 3D scene builder — the three.js half of the preview, with three.js
 * DEPENDENCY-INJECTED so it carries no static `three` import. That keeps the
 * heavy engine fully code-split (the React viewer loads it via safeDynamicImport
 * and passes it in) AND lets the screenshot harness build the identical scene
 * for visual QA off one implementation.
 *
 * It turns a `resolveTogoScene` spec into a furniture THREE.Group: each piece is
 * a pile of RoundedBoxes (lib/togo/togoModel) sized to its real footprint,
 * upholstered in the chosen fabric (a swatch texture, or a tasteful default
 * Togo colour), placed + rotated to match the 2D plan. When real Togo GLBs land
 * (the dealer's pCon/OFML channel), swap the per-piece build for a glTF load —
 * the layout/material wiring here is unchanged.
 */
import { togoParts } from '../../lib/togo/togoModel.js';

// Default Togo upholstery when no fabric is picked — a warm, mid neutral that
// reads as fabric under the studio IBL (not flat plastic).
const DEFAULT_COLOR = 0xB8AFA3;
const DEG = Math.PI / 180;

/**
 * Procedural fabric GRAIN normal map — the fine woven micro-relief that keeps
 * the upholstery from reading as smooth plastic (the big quilt CHANNELS are real
 * geometry now, see togoModel.togoParts). Built once (canvas heightfield →
 * finite-difference normals), tiled on every fabric material. A non-zero
 * `channels` still bakes in soft horizontal grooves if ever wanted.
 * Returns a THREE.Texture (linear — it's a normal map, not colour).
 */
export function makeQuiltNormalMap(THREE, { size = 256, channels = 0, weave = 150, strength = 1.4 } = {}) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const TAU = Math.PI * 2;
  // Height field: a fine woven grain (+ optional soft horizontal grooves).
  const H = (x, y) => {
    const v = y / size, u = x / size;
    const ch = channels ? (Math.cos(v * TAU * channels) * 0.5 + 0.5) ** 1.7 : 0;
    const grain = (Math.sin(u * TAU * weave) + Math.sin(v * TAU * weave)) * 0.5;
    return ch + grain * 0.18;
  };
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = H((x - 1 + size) % size, y), hR = H((x + 1) % size, y);
      const hD = H(x, (y - 1 + size) % size), hU = H(x, (y + 1) % size);
      let nx = (hL - hR) * strength, ny = (hD - hU) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * A physically-based fabric material — the single biggest fidelity lever for
 * upholstery. MeshPhysicalMaterial adds a SHEEN lobe (the soft retro-reflective
 * glow real fabric has at grazing angles), tuned by the material editor. Takes
 * the swatch texture (tiled, sRGB) or a neutral colour, plus an optional weave
 * normal map. `tex` is an already-loaded THREE.Texture or null.
 */
export function makeFabricMaterial(THREE, tex, opts = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(opts.color ?? (tex ? 0xffffff : DEFAULT_COLOR)),
    roughness: opts.roughness ?? 0.82,
    metalness: 0,
    sheen: opts.sheen ?? 0.5,
    sheenRoughness: opts.sheenRoughness ?? 0.55,
    sheenColor: new THREE.Color(opts.sheenColor ?? 0xffffff),
    envMapIntensity: opts.envMapIntensity ?? 1.05,
  });
  if (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;        // base colour is sRGB
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;  // tile the small swatch
    tex.repeat.set(opts.repeat || 3, opts.repeat || 3);
    tex.anisotropy = opts.anisotropy || 8;
    mat.map = tex;
  }
  if (opts.normalMap) {
    mat.normalMap = opts.normalMap;
    const ns = opts.normalScale ?? 0.5;
    mat.normalScale = new THREE.Vector2(ns, ns);
  }
  return mat;
}

/**
 * Drop a loaded REAL model (a pCon export — GLB/OBJ/FBX/DAE/3DS, already
 * tessellated) into a piece group: clone it, upholster every mesh in the piece's
 * fabric material (so "drag a fabric" works exactly like in pCon), apply the
 * descriptor's unit scale + axis/facing fixups, then recentre on XZ and sit it
 * on the floor — so the export's own origin/scale/up-axis don't matter.
 */
function placeRealModel(THREE, object, material, desc, pieceGroup) {
  const clone = object.clone(true);
  clone.traverse((o) => {
    if (o.isMesh) {
      o.material = material;
      // clone(true) shares the source geometry by reference; clone it so the
      // group OWNS its buffers and disposeGroup never frees the cached model's.
      if (o.geometry) o.geometry = o.geometry.clone();
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  if (desc?.upAxis === 'z') clone.rotation.x = -Math.PI / 2;       // CAD Z-up → three Y-up
  if (desc?.rotateY) clone.rotation.y += (desc.rotateY * Math.PI) / 180;
  clone.scale.setScalar(desc?.scale || 1);                          // drawing units → cm

  const wrap = new THREE.Group();
  wrap.add(clone);
  wrap.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrap);
  const c = box.getCenter(new THREE.Vector3());
  wrap.position.x -= c.x;
  wrap.position.z -= c.z;
  wrap.position.y -= box.min.y;
  pieceGroup.add(wrap);
}

/**
 * Build the furniture group from a scene spec. `textureFor(fabricCode)` returns
 * a THREE.Texture or null (the caller owns loading/caching). `modelFor(piece)`
 * returns `{ object, desc }` for a real loaded model (or null to fall back to
 * procedural geometry) — so the SAME scene shows real Togo models the moment
 * they're wired and generated cushions until then. Pieces share one material
 * each (one per piece), so a fabric swap is a single `.map` change.
 */
export function buildTogoGroup(deps, scene3d, opts = {}) {
  const { THREE, RoundedBoxGeometry } = deps;
  const textureFor = opts.textureFor || (() => null);
  const modelFor = opts.modelFor || (() => null);
  const group = new THREE.Group();

  for (const piece of (scene3d?.pieces || [])) {
    const pieceGroup = new THREE.Group();
    const material = makeFabricMaterial(THREE, textureFor(piece.fabricCode), opts);
    const real = modelFor(piece);
    if (real && real.object) {
      placeRealModel(THREE, real.object, material, real.desc, pieceGroup);
    } else {
      for (const part of togoParts(piece.widthCm, piece.depthCm, piece.form)) {
        let mesh;
        if (part.shape === 'ridge') {
          // A channel: a capsule laid along the width (x) or depth (z).
          mesh = new THREE.Mesh(new THREE.CapsuleGeometry(part.radius, part.length, 8, 18), material);
          mesh.rotation[part.axis === 'x' ? 'z' : 'x'] = Math.PI / 2;
        } else {
          const seg = Math.max(2, Math.round(part.r / 4));
          mesh = new THREE.Mesh(new RoundedBoxGeometry(part.w, part.h, part.d, seg, part.r), material);
        }
        mesh.position.set(part.x, part.y, part.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        pieceGroup.add(mesh);
      }
    }
    // Plan x→world x, plan y→world z; the plan's clockwise screen rotation is a
    // negative rotation about the up axis in three's right-handed XZ floor.
    pieceGroup.position.set(piece.x, 0, piece.z);
    pieceGroup.rotation.y = -(piece.rotationDeg || 0) * DEG;
    group.add(pieceGroup);
  }
  return group;
}

/** The radius of the layout (cm) for framing the camera — half the footprint
 *  diagonal, with a floor for a single small piece. */
export function sceneRadius(scene3d) {
  const o = scene3d?.overallCm || { widthCm: 0, depthCm: 0 };
  return Math.max(90, Math.hypot(o.widthCm, o.depthCm) / 2);
}

/**
 * Studio rig: a neutral image-based environment (RoomEnvironment — no HDR asset
 * to ship) for soft realistic fabric shading, a key light that casts a soft
 * ground shadow, fill, and a large floor that only catches shadow. Mutates
 * `scene` and returns a dispose(). The caller owns the renderer/camera/controls.
 */
export function setupTogoStage(deps, renderer, scene, radius) {
  const { THREE, RoomEnvironment } = deps;
  scene.background = new THREE.Color(0xF4F1EC);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;

  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.position.set(radius * 0.8, radius * 1.6, radius * 0.9);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const d = radius * 2.2;
  Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: radius * 6 });
  key.shadow.bias = -0.0004;
  key.shadow.radius = 6;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 0.5));

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 12, radius * 12),
    new THREE.ShadowMaterial({ opacity: 0.22 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.receiveShadow = true;
  scene.add(floor);

  return () => {
    envRT.texture.dispose();
    pmrem.dispose();
    if (typeof envScene.dispose === 'function') envScene.dispose();
    floor.geometry.dispose();
    floor.material.dispose();
  };
}

/** Dispose every geometry/material/(swatch) texture under a group (free GPU
 *  memory). Idempotent per object via a seen-set, so a material/geometry shared
 *  across many meshes (the real-model path) is disposed exactly ONCE. The shared
 *  quilt normal map is intentionally NOT touched — the owner disposes it. */
export function disposeGroup(group) {
  const seen = new Set();
  const once = (o, fn) => { if (o && !seen.has(o)) { seen.add(o); fn(); } };
  group?.traverse?.((o) => {
    once(o.geometry, () => o.geometry.dispose());
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      once(m.map, () => m.map.dispose());
      once(m, () => m.dispose());
    }
  });
}
