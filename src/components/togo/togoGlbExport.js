/**
 * Togo GLB export — the bridge from our live three.js scene to portable 3D
 * formats (GLB) so the configured sofa can be launched into WebAR ("Ver en tu
 * espacio") and, on iOS, auto-converted to USDZ by <model-viewer> for AR Quick
 * Look. three.js is DEPENDENCY-INJECTED (same pattern as togoSceneBuilder) so
 * this carries no static `three` import and stays fully code-split — the AR
 * viewer loads three + the exporter only when a visitor taps AR.
 *
 * The export reuses `buildTogoGroup`, so the GLB is upholstered in the SAME
 * physically-based fabric (sheen lobe + quilt normal map + the chosen swatch)
 * the inline 3D preview shows — GLTFExporter writes the sheen as the standard
 * KHR_materials_sheen extension, so model-viewer (and Scene Viewer / Quick Look)
 * render real Togo upholstery, not flat plastic.
 *
 * Units: the scene is authored in CENTIMETRES; glTF's unit is the METRE, so the
 * exported root is scaled 0.01 — that's what makes AR place the sofa
 * TRUE-TO-SCALE in the customer's room.
 */
import { buildTogoGroup, makeQuiltNormalMap, disposeGroup, sampleSwatchColor } from './togoSceneBuilder.js';

const CM_TO_M = 0.01;

/**
 * Load the distinct fabric swatches in a scene as THREE.Textures, keyed by code.
 * `urlFor(code)` returns a (CORS-safe) image URL or null. Failures are swallowed
 * (a 404 swatch just falls back to the default Togo colour) so one bad code
 * never blocks the export. Returns a Map<code, THREE.Texture>.
 */
export async function loadFabricTextures(THREE, codes, urlFor) {
  const out = new Map();
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin?.('anonymous');
  await Promise.all([...new Set((codes || []).filter(Boolean))].map(async (code) => {
    const url = urlFor(code);
    if (!url) return;
    try { out.set(code, await loader.loadAsync(url)); } catch { /* missing → default colour */ }
  }));
  return out;
}

/**
 * Build the AR-ready group from a `resolveTogoScene` spec: the furniture group
 * (no studio rig — model-viewer lights it), upholstered, then wrapped in a root
 * scaled cm→m. Returns { root, quilt, dispose } — the caller owns disposal.
 * `opts` carries the fabric finish (sheen/roughness/repeat/normalScale) + a
 * `textures` Map from loadFabricTextures.
 */
export function buildArGroup(deps, scene3d, opts = {}) {
  const { THREE } = deps;
  const textures = opts.textures instanceof Map ? opts.textures : new Map();
  const quilt = makeQuiltNormalMap(THREE);
  const rep = opts.repeat || 3;
  if (quilt) quilt.repeat.set(rep, rep);

  // Upholster in each swatch's DOMINANT colour (sampled once from the loaded
  // image), matching the inline preview — not the tiled photo. KHR_materials_sheen
  // then carries the velvet sheen into AR (Scene Viewer / Quick Look).
  const colors = new Map();
  textures.forEach((t, code) => { const c = sampleSwatchColor(t?.image); if (c != null) colors.set(code, c); });

  const group = buildTogoGroup(deps, scene3d, {
    ...opts,
    normalMap: quilt,
    colorFor: (code) => (colors.has(code) ? colors.get(code) : null),
  });

  const root = new THREE.Group();
  root.add(group);
  root.scale.setScalar(CM_TO_M);     // centimetres → metres (AR true-to-scale)
  root.updateMatrixWorld(true);

  const dispose = () => {
    disposeGroup(root);                      // geometries, materials, cloned swatch maps
    quilt?.dispose?.();                      // the shared normal map (disposeGroup skips it)
    textures.forEach((t) => t.dispose?.());  // the original loaded swatches
  };
  return { root, quilt, dispose };
}

/**
 * Export a three.js Object3D to a binary glTF (GLB) Blob via GLTFExporter
 * (dependency-injected). Resolves to a Blob of type model/gltf-binary the View
 * wraps in an object URL for <model-viewer>.
 */
export function exportGlbBlob(deps, object) {
  const { GLTFExporter } = deps;
  return new Promise((resolve, reject) => {
    try {
      const exporter = new GLTFExporter();
      exporter.parse(
        object,
        (result) => {
          const buf = result instanceof ArrayBuffer ? result : new TextEncoder().encode(JSON.stringify(result));
          resolve(new Blob([buf], { type: 'model/gltf-binary' }));
        },
        (err) => reject(err instanceof Error ? err : new Error('GLB export failed')),
        { binary: true },
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
