/**
 * FBX → plan, in the browser. The runtime half of the mesh-native plan pipeline:
 * loads a dealer-uploaded mesh once (three.js + the loader for its extension, all
 * code-split), pulls its FLOOR triangles (the lower body that actually sits on the
 * ground — a leaning backrest roll is excluded so the footprint isn't inflated),
 * scales them to centimetres, and runs the pure `meshPlanFromTriangles` to get the
 * top-down plan SVG + footprint. Cached per URL so the 2D tile and the 3D view
 * derive from the SAME mesh without loading it twice.
 *
 * This REPLACES the DWG plan (planGeometry/dwgToPlan) for any piece that has a
 * mesh: the plan a tile renders is literally its FBX seen from above.
 */
import { safeDynamicImport } from '../dynamicImport.js';
import { meshPlanFromTriangles } from './meshToPlan.js';
import { autoUnitScale } from './togoModel.js';

const extOf = (url) => String(url || '').split('?')[0].split('.').pop().toLowerCase();

async function loadObject(url) {
  const ext = extOf(url);
  const THREE = await safeDynamicImport(() => import('three'));
  let loader;
  switch (ext) {
    case 'glb': case 'gltf': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/GLTFLoader.js')); loader = new m.GLTFLoader(); break; }
    case 'obj': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/OBJLoader.js')); loader = new m.OBJLoader(); break; }
    case 'fbx': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/FBXLoader.js')); loader = new m.FBXLoader(); break; }
    case 'dae': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/ColladaLoader.js')); loader = new m.ColladaLoader(); break; }
    case '3ds': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/TDSLoader.js')); loader = new m.TDSLoader(); break; }
    default: return null;
  }
  const res = await loader.loadAsync(url);
  const obj = (ext === 'glb' || ext === 'gltf' || ext === 'dae') ? (res.scene || res.scenes?.[0] || res) : res;
  return obj ? { THREE, obj } : null;
}

const objCache = new Map();   // url → Promise<{ THREE, obj }>  (kept: the top-down renderer clones it)

/** Load a mesh once and KEEP it (the plan extraction and the top-down render both
 *  clone from this single source). Rejects on an unreadable/unsupported mesh. */
export function loadMeshObject(url) {
  if (!url) return Promise.reject(new Error('no mesh url'));
  if (objCache.has(url)) return objCache.get(url);
  const p = loadObject(url).then((l) => { if (!l) throw new Error('unsupported mesh'); return l; });
  p.catch(() => objCache.delete(url));
  objCache.set(url, p);
  return p;
}

// Lower-body triangles projected to the ground plane, in cm. `upAxis` says which
// axis is vertical ('y' default, 'z' for some CAD exports). Same height-normalised
// scale the 3D placement uses, so plan cm == 3D cm.
function floorTriangles(THREE, object, upAxis, cutFrac = 0.4) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const up = upAxis === 'z' ? 2 : 1;          // vertical component
  const fa = 0;                               // floor axis A (x)
  const fb = upAxis === 'z' ? 1 : 2;          // floor axis B (y if z-up, else z)
  const sUp = size.getComponent(up);
  if (!(sUp > 0)) return [];
  // Auto-unit guard — the SAME factor placeRealModel applies to the 3D model (both
  // from the native height), so the plan footprint matches the rendered piece. It
  // only corrects a gross mm/cm/m export; a cm export keeps its true footprint.
  const k = autoUnitScale(sUp);
  const cut = box.min.getComponent(up) + sUp * cutFrac;
  const oa = box.min.getComponent(fa), ob = box.min.getComponent(fb);
  const tris = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  object.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    o.updateWorldMatrix(true, false);
    const pos = o.geometry.attributes.position, idx = o.geometry.index, mw = o.matrixWorld;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
      if ((a.getComponent(up) + b.getComponent(up) + c.getComponent(up)) / 3 > cut) continue;
      tris.push(
        (a.getComponent(fa) - oa) * k, (a.getComponent(fb) - ob) * k,
        (b.getComponent(fa) - oa) * k, (b.getComponent(fb) - ob) * k,
        (c.getComponent(fa) - oa) * k, (c.getComponent(fb) - ob) * k,
      );
    }
  });
  return tris;
}

const cache = new Map();   // `${url}|${upAxis}` → Promise<{ svg, widthCm, depthCm }>

/**
 * Plan (top-down SVG + cm footprint) for a mesh URL, computed once and cached.
 * Rejects only on an unreadable mesh; the caller falls back to the stored plan.
 */
export function loadMeshPlan(url, { upAxis = 'y' } = {}) {
  if (!url) return Promise.reject(new Error('no mesh url'));
  const key = `${url}|${upAxis}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const { THREE, obj } = await loadMeshObject(url);   // shared, cached (not disposed)
    let tris = floorTriangles(THREE, obj, upAxis, 0.4);
    let plan = meshPlanFromTriangles(tris);
    // A degenerate lower slice (a flat-on-the-floor export) → fall back to the
    // whole silhouette so we still get a real footprint.
    if (!plan.svg) { tris = floorTriangles(THREE, obj, upAxis, 1.0); plan = meshPlanFromTriangles(tris); }
    if (!plan.svg) throw new Error('no plan geometry');
    return { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm };
  })();
  p.catch(() => cache.delete(key));   // let a transient failure retry next mount
  cache.set(key, p);
  return p;
}
