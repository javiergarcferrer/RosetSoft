/**
 * Rendered PERSPECTIVE thumbnails for the Togo models — a small offscreen
 * three.js render of each piece (the real FBX, the studio rig), framed at a
 * flattering 3/4 angle and exported as a PNG data URL. These replace the
 * hand-drawn wireframes in the picker/hotbar/selected-piece header so every
 * model reads as a true rendered representation of its shape, consistent with
 * the live 3D stage (same builder, same lighting).
 *
 * One shared offscreen renderer is reused for every model (created lazily, kept
 * for the session); pieces render sequentially so they never contend for the
 * GPU. The heavy three import is code-split via safeDynamicImport, exactly like
 * the live stage, so the picker stays light until a thumbnail is actually wanted.
 */
import { useEffect, useState } from 'react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import { inferTogoForm } from '../../lib/togo/togoModel.js';
import { loadTogoModels } from './togoModelLoader.js';
import { buildTogoGroup, setupTogoStage, disposeGroup, makeFabricMaps, sampleSwatchColor, STANDARD_TOGO_FINISH } from './togoSceneBuilder.js';

const SIZE = 320;                         // px (square) before DPR
const cache = new Map();                  // `${modelId}:${fabricCode}` → data URL (session-lived)
const colorCache = new Map();             // fabric code → sampled hex (or null), session-lived

/** The dominant colour (hex) of a fabric swatch, sampled once and cached — the
 *  SAME read the live stage does, so a Resumen thumbnail matches the placed
 *  piece. CORS-clean via the swatch-proxy; a failure resolves to null (oatmeal). */
async function colorForCode(THREE, code) {
  if (!code) return null;
  if (colorCache.has(code)) return colorCache.get(code);
  const url = swatchProxyUrl(code) || swatchUrl(code);
  if (!url) { colorCache.set(code, null); return null; }
  try {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    const c = sampleSwatchColor(tex.image); tex.dispose?.();
    colorCache.set(code, c ?? null);
    return c ?? null;
  } catch { colorCache.set(code, null); return null; }
}

let enginePromise = null;
async function getEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const [THREE, { RoomEnvironment }, { RoundedBoxGeometry }] = await Promise.all([
      safeDynamicImport(() => import('three')),
      safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
      safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
    ]);
    const deps = { THREE, RoomEnvironment, RoundedBoxGeometry };
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(SIZE, SIZE);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setClearColor(0x000000, 0);        // transparent — sits on any card
    const scene = new THREE.Scene();
    const disposeStage = setupTogoStage(deps, renderer, scene, 120);
    scene.background = null;                     // keep it transparent (stage set a colour)
    const { normalMap: quilt, grainMap: grain } = makeFabricMaps(THREE);
    const camera = new THREE.PerspectiveCamera(28, 1, 1, 6000);
    return { THREE, deps, renderer, scene, camera, quilt, grain, disposeStage, modelCache: new Map() };
  })();
  return enginePromise;
}

// All renders share ONE offscreen renderer/scene, so they MUST run one at a time
// — two concurrent calls (the hotbar's generic hook + the Resumen's per-fabric
// hook) would otherwise add both groups to the scene at once and cross-render.
// Chain every call through this promise so they serialise (and the chain survives
// a single failure).
let renderChain = Promise.resolve();
export function renderTogoThumb(model, opts = {}) {
  const next = renderChain.then(() => _renderTogoThumb(model, opts), () => _renderTogoThumb(model, opts));
  renderChain = next.catch(() => {});
  return next;
}

/** Render ONE model to a PNG data URL, in the given fabric (`opts.code`) or the
 *  default oatmeal body when no code. Cached by `${modelId}:${code}`. */
async function _renderTogoThumb(model, { code = '' } = {}) {
  if (!model?.id) return null;
  const cacheKey = `${model.id}:${code}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let eng;
  try { eng = await getEngine(); } catch { return null; }
  const { THREE, deps, renderer, scene, camera, quilt, grain, modelCache } = eng;
  const color = await colorForCode(THREE, code);   // the chosen fabric's hue (or null)
  const w = Number(model.widthCm) || 90, d = Number(model.depthCm) || 90;
  const form = inferTogoForm(model.name || model.label || '', w, d);
  const piece = { uid: 't', widthCm: w, depthCm: d, form, x: 0, z: 0, rotationDeg: 0, fabricCode: code, mesh: model.mesh || null };

  let group = null;
  try {
    const loaded = await loadTogoModels({ pieces: [piece] }, modelCache);
    // Render the preview EXACTLY as the placed piece reads: the standard velvet
    // (terciopelo) finish in the chosen fabric colour (or the oatmeal body when
    // none), so the thumbnail matches what's on the plan and reads its shape.
    group = buildTogoGroup(deps, { pieces: [piece] }, {
      ...STANDARD_TOGO_FINISH, normalMap: quilt, grainMap: grain,
      colorFor: () => color, modelFor: loaded.modelFor,
    });
    scene.add(group);

    // Frame the piece at a flattering low 3/4 angle (open front toward camera).
    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.hypot(size.x, size.y, size.z) / 2;
    const dist = (r / Math.tan((28 * Math.PI / 180) / 2)) * 1.08;
    camera.position.set(c.x + dist * 0.42, c.y + dist * 0.52, c.z + dist * 0.86);
    camera.lookAt(c.x, c.y + size.y * 0.12, c.z);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    cache.set(cacheKey, url);
    return url;
  } catch {
    return null;
  } finally {
    if (group) { scene.remove(group); disposeGroup(group); }
  }
}

/**
 * Hook: returns `{ [modelId]: pngDataUrl }`, filling in as each model renders
 * (sequentially). Re-runs only when the model set changes. A model that fails
 * to render is simply absent → the caller falls back to its wireframe/svg.
 */
export function useTogoThumbnails(models) {
  const [thumbs, setThumbs] = useState({});
  const key = (models || []).map((m) => `${m?.id}:${m?.mesh?.url || ''}`).join('|');
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const m of (models || [])) {
        if (!alive) return;
        const url = await renderTogoThumb(m);
        if (!alive) return;
        if (url) setThumbs((prev) => (prev[m.id] === url ? prev : { ...prev, [m.id]: url }));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return thumbs;
}

/**
 * Hook: renders each placed piece in its CHOSEN fabric and returns
 * `{ [rowKey]: pngDataUrl }` — for the Resumen, where a row must show the model
 * tinted to the fabric the customer picked. `rows` is `[{ key, model, code }]`;
 * a row with no code is skipped (the caller falls back to the generic render).
 */
export function useTogoFabricThumbs(rows) {
  const [thumbs, setThumbs] = useState({});
  const key = (rows || []).map((r) => `${r?.key}:${r?.code || ''}`).join('|');
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const r of (rows || [])) {
        if (!alive) return;
        if (!r?.code || !r?.model?.id) continue;
        const url = await renderTogoThumb(r.model, { code: r.code });
        if (!alive) return;
        if (url) setThumbs((prev) => (prev[r.key] === url ? prev : { ...prev, [r.key]: url }));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return thumbs;
}
