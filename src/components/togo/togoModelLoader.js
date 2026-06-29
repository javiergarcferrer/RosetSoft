/**
 * Shared loader for REAL Togo models (pCon / dealer exports — GLB/OBJ/FBX/DAE/3DS).
 * ONE implementation behind BOTH the inline 3D view (TogoScene3D) and the WebAR
 * export (TogoArViewer), so AR places the SAME real meshes the preview shows —
 * not the procedural fallback. The three.js loaders are code-split via
 * `safeDynamicImport`, so a scene with no real models pulls in no loader at all.
 */
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { glbForPiece } from '../../assets/togo/togoModels3d.js';

/** File extension of a model URL (query-stripped, lowercased). */
export const extOf = (url) => String(url || '').split('?')[0].split('.').pop().toLowerCase();

/** The three.js loader for a model extension, imported on demand. pCon exports
 *  OBJ/FBX/3DS/DAE; GLB/glTF for anything authored web-side. */
export async function loaderFor(ext) {
  switch (ext) {
    case 'glb': case 'gltf': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/GLTFLoader.js')); return new m.GLTFLoader(); }
    case 'obj': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/OBJLoader.js')); return new m.OBJLoader(); }
    case 'fbx': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/FBXLoader.js')); return new m.FBXLoader(); }
    case 'dae': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/ColladaLoader.js')); return new m.ColladaLoader(); }
    case '3ds': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/TDSLoader.js')); return new m.TDSLoader(); }
    default: return null;
  }
}

/** glTF/Collada return a wrapper with `.scene`; OBJ/FBX/3DS return the Object3D. */
export const normalizeLoaded = (ext, res) => ((ext === 'glb' || ext === 'gltf' || ext === 'dae') ? (res.scene || res.scenes?.[0] || res) : res);

/** A piece's model descriptor: a dealer-uploaded mesh (Storage) wins over the
 *  static manifest. Returns `{ url, upAxis?, rotateY?, scale? }` or null. */
export const descForPiece = (p) => ((p && p.mesh && p.mesh.url) ? p.mesh : glbForPiece(p));

/**
 * Load every DISTINCT real model in a scene into `cache` (Map<url, {object, desc}>),
 * reusing whatever's already cached (so re-builds don't reload, and two pieces
 * sharing a model load it once). A missing/unreadable model is skipped → that
 * piece falls back to procedural geometry. Returns `{ cache, modelFor }`, where
 * `modelFor(piece)` is the selector `buildTogoGroup` expects.
 */
export async function loadTogoModels(scene3d, cache = new Map()) {
  const descByUrl = new Map();
  for (const p of (scene3d?.pieces || [])) {
    const d = descForPiece(p);
    if (d?.url) descByUrl.set(d.url, d);
  }
  await Promise.all([...descByUrl.values()].map(async (desc) => {
    if (cache.has(desc.url)) return;
    const ext = extOf(desc.url);
    try {
      const loader = await loaderFor(ext);
      if (!loader) return;
      const object = normalizeLoaded(ext, await loader.loadAsync(desc.url));
      if (object) cache.set(desc.url, { object, desc });
    } catch { /* missing/unreadable → procedural */ }
  }));
  const modelFor = (piece) => { const d = descForPiece(piece); return d ? (cache.get(d.url) || null) : null; };
  return { cache, modelFor };
}
