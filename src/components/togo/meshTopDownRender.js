/**
 * Top-down realistic render of a Togo piece for the 2D plan tile — the FBX seen
 * from straight above, upholstered with the same PBR fabric + soft shadow as the 3D
 * view, so the plan reads like the real product instead of a flat outline.
 *
 * Reuses the 3D scene builder (buildTogoGroup + the quilt/IBL/fabric material) on a
 * private offscreen WebGL renderer with an ORTHOGRAPHIC top camera and a steep key
 * light, so the contact shadow is tight and symmetric — rotation-invariant, since
 * the tile is CSS-rotated per placement. Returns a transparent PNG data URL, or
 * null when WebGL is unavailable so the caller falls back to the silhouette plan.
 * Renders are serialized on the one renderer and cached per mesh+footprint.
 */
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { loadMeshObject } from '../../lib/togo/meshPlanCache.js';
import { buildTogoGroup, makeQuiltNormalMap, disposeGroup } from './togoSceneBuilder.js';

const MARGIN = 1.14;     // frame a little wider than the footprint, to fit the shadow
const PX_PER_CM = 5;     // render resolution

let _rig = null;
let _failed = false;
async function rig() {
  if (_rig) return _rig;
  if (_failed) return null;
  try {
    const [THREE, { RoomEnvironment }, { RoundedBoxGeometry }] = await Promise.all([
      safeDynamicImport(() => import('three')),
      safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
      safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
    ]);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    const quilt = makeQuiltNormalMap(THREE); if (quilt) quilt.repeat.set(4, 4);
    _rig = { THREE, deps: { THREE, RoomEnvironment, RoundedBoxGeometry }, renderer, quilt };
    return _rig;
  } catch { _failed = true; return null; }
}

// IBL + a steep key (tight, symmetric contact shadow) + a shadow-only floor on a
// transparent background. Returns dispose().
function topStage(deps, renderer, scene, radius) {
  const { THREE, RoomEnvironment } = deps;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new RoomEnvironment();
  const rt = pmrem.fromScene(env, 0.04);
  scene.environment = rt.texture;
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(radius * 0.22, radius * 3, radius * 0.3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const d = radius * 1.7;
  Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: radius * 9 });
  key.shadow.bias = -0.0005; key.shadow.radius = 5;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 0.32));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 10, radius * 10), new THREE.ShadowMaterial({ opacity: 0.26 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);
  return () => { rt.texture.dispose(); pmrem.dispose(); env.dispose?.(); floor.geometry.dispose(); floor.material.dispose(); };
}

async function render(piece) {
  const r = await rig();
  if (!r) return null;
  const { THREE, deps, renderer, quilt } = r;
  let object;
  try { ({ obj: object } = await loadMeshObject(piece.url)); } catch { return null; }

  const W = Math.max(8, piece.widthCm), D = Math.max(8, piece.depthCm);
  const radius = Math.max(60, Math.hypot(W, D) / 2);
  const scene = new THREE.Scene();
  const disposeStage = topStage(deps, renderer, scene, radius);
  const scene3d = {
    pieces: [{
      x: 0, z: 0, rotationDeg: 0, widthCm: W, depthCm: D, form: piece.form, fabricCode: null,
      mesh: { url: piece.url, upAxis: piece.upAxis, rotateY: piece.rotateY, scale: piece.scale },
    }],
    overallCm: { widthCm: W, depthCm: D },
  };
  const group = buildTogoGroup(deps, scene3d, {
    normalMap: quilt,
    colorFor: () => null,    // neutral upholstery — the fabric is shown via the swatch chip
    modelFor: () => ({ object, desc: { upAxis: piece.upAxis, rotateY: piece.rotateY, scale: piece.scale } }),
  });
  scene.add(group);

  // Frame the camera to the mesh's ACTUAL rendered footprint, not the catalogue
  // widthCm×depthCm: buildTogoGroup/placeRealModel re-scales the model to a common
  // height, so its real top-down extent differs from the passed dims — framing the
  // latter left an empty border around the piece (the "letterbox"). Measuring the
  // world bounding box makes the piece fill the frame, and the tile sizes its image
  // to fw×fd so there's no stretch either. The frustum + canvas share fw:fd aspect.
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const fw = Math.max(1, size.x), fd = Math.max(1, size.z);
  const halfW = (fw / 2) * MARGIN, halfD = (fd / 2) * MARGIN;
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfD, -halfD, 1, radius * 14);
  cam.position.set(mid.x, mid.y + radius * 6, mid.z);
  cam.up.set(0, 0, -1);                  // world +X→right, +Z→down — matches the plan
  cam.lookAt(mid.x, mid.y, mid.z);

  renderer.setSize(Math.round(fw * MARGIN * PX_PER_CM), Math.round(fd * MARGIN * PX_PER_CM), false);
  renderer.render(scene, cam);
  let dataUrl = null;
  try { dataUrl = renderer.domElement.toDataURL('image/png'); } catch { dataUrl = null; }

  scene.remove(group); disposeGroup(group); disposeStage();
  return dataUrl ? { dataUrl, margin: MARGIN, wCm: fw, hCm: fd } : null;
}

const cache = new Map();        // key → Promise<{ dataUrl, margin } | null>
let chain = Promise.resolve();  // one render at a time on the single renderer

/** Cached top-down render for a piece (neutral upholstery), keyed by mesh+footprint. */
export function renderMeshTopDown(piece) {
  if (!piece?.url || !(piece.widthCm > 0) || !(piece.depthCm > 0)) return Promise.resolve(null);
  const key = `${piece.url}|${piece.upAxis || 'y'}|${Math.round(piece.widthCm)}x${Math.round(piece.depthCm)}`;
  if (cache.has(key)) return cache.get(key);
  const p = (chain = chain.then(() => render(piece).catch(() => null)));
  p.then((v) => { if (!v) cache.delete(key); });   // let a transient failure retry
  cache.set(key, p);
  return p;
}
