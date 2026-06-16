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

/** A fabric material: the swatch texture tiled over a matte dielectric, or a
 *  neutral fallback colour. `tex` is an already-loaded THREE.Texture or null. */
export function makeFabricMaterial(THREE, tex, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  if (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;       // base colour is sRGB (research-confirmed)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // tile the small swatch
    tex.repeat.set(opts.repeat || 3, opts.repeat || 3);
    tex.anisotropy = opts.anisotropy || 4;
    mat.map = tex;
  } else {
    mat.color = new THREE.Color(opts.color ?? DEFAULT_COLOR);
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
    if (o.isMesh) { o.material = material; o.castShadow = true; o.receiveShadow = true; }
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
        const seg = Math.max(2, Math.round(part.r / 4));
        const geo = new RoundedBoxGeometry(part.w, part.h, part.d, seg, part.r);
        const mesh = new THREE.Mesh(geo, material);
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

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
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

/** Dispose every geometry/material/texture under a group (free GPU memory). */
export function disposeGroup(group) {
  group?.traverse?.((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}
