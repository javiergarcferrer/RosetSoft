/**
 * In-browser DWG → top-down plan converter for the Togo catalog uploader.
 *
 * Loads the libredwg WASM (served from /public/libredwg, NOT bundled), parses an
 * uploaded .dwg, and reuses the SAME pure geometry as the build script
 * (planGeometry.js) — so a dealer-uploaded model lands identical to the seeded
 * ones. The 6 MB wasm downloads ONCE, lazily, only when a dealer actually drops a
 * file (the admin page code-splits this module via safeDynamicImport). It prefers
 * Ligne Roset's "Mobilier 2D" plan layer, then any "2D" layer, then everything.
 */
import { LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web';
import { planFromDb, PLAN_LAYER } from './planGeometry.js';

let _instance = null;
function instance() {
  if (!_instance) {
    // locateFile resolves `${dir}/libredwg-web.wasm`; the wasm is a committed
    // public asset so there's no bundler wasm-emit magic to get wrong.
    const dir = `${import.meta.env.BASE_URL || '/'}libredwg`.replace(/\/{2,}/g, '/');
    _instance = LibreDwg.create(dir);
  }
  return _instance;
}

/** Pick the best plan layer present: the named one, then any "2D", else all. */
function pickLayer(db) {
  const names = (db?.tables?.LAYER?.entries || []).map((l) => l.name);
  if (names.includes(PLAN_LAYER)) return PLAN_LAYER;
  const twoD = names.find((n) => /\b2d\b/i.test(n) && !/texte|text/i.test(n));
  return twoD || null; // null ⇒ collect every layer
}

/**
 * Convert a .dwg ArrayBuffer → { svg, widthCm, depthCm, layer, layers, warning }.
 * Throws only on an unreadable file; an empty result (no plan geometry) returns a
 * `warning` so the UI can explain it instead of silently saving a blank symbol.
 */
export async function dwgToPlan(arrayBuffer, opts = {}) {
  const lib = await instance();
  const dwg = lib.dwg_read_data(new Uint8Array(arrayBuffer), Dwg_File_Type.DWG);
  try {
    const db = lib.convert(dwg);
    const layer = opts.layer !== undefined ? opts.layer : pickLayer(db);
    const plan = planFromDb(db, { layer });
    const layers = (db?.tables?.LAYER?.entries || []).map((l) => l.name);
    return {
      ...plan,
      chosenLayer: layer,
      layers,
      warning: plan.polyCount === 0 ? 'no-geometry' : (layer === PLAN_LAYER ? null : 'fallback-layer'),
    };
  } finally {
    lib.dwg_free(dwg);
  }
}
