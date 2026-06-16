/**
 * Real Togo 3D models (GLB), keyed by canonical piece kind (chauf · a · gb · mc
 * · lounge — see pieces.js). EMPTY until the dealer exports the official Togo
 * geometry to GLB and drops the files in `public/togo-models/`.
 *
 * WHY this is empty: the source DWGs (scripts/togo-dwg/*.dwg, AutoCAD 2013 /
 * AC1027) DO carry the real 3D bodies on their "Mobilier 3D" layer — pCon
 * renders them — but our in-browser DWG reader (@mlightcad/libredwg-web) can't
 * decode AC1027 ACIS solids, and there's no CAD kernel in the build to tessellate
 * them. So the 3D view ships with procedural geometry (lib/togo/togoModel.js)
 * sized to the real footprints, and upgrades to these GLBs the moment they exist
 * — no other code changes. The dealer's pCon/OFML trade access (Ligne Roset
 * joined the pCon Community in Dec 2025) is the clean source for the GLB export.
 *
 * To add a model: export the piece to GLB (authored in centimetres, +Y up, the
 * sofa facing +Z), put it at public/togo-models/<id>.glb, and add an entry:
 *   a: { url: '/togo-models/a.glb', scale: 1 },   // scale = drawing units → cm
 * The renderer recentres + floors it automatically, so the GLB's own origin
 * doesn't matter.
 */
export const TOGO_GLB = {
  // chauf: { url: '/togo-models/chauf.glb', scale: 1 },
  // a:     { url: '/togo-models/a.glb', scale: 1 },
  // gb:    { url: '/togo-models/gb.glb', scale: 1 },
  // mc:    { url: '/togo-models/mc.glb', scale: 1 },
  // lounge:{ url: '/togo-models/lounge.glb', scale: 1 },
};

/** The GLB descriptor for a kind, or null when no real model is available yet. */
export function glbFor(kind) {
  return (kind && TOGO_GLB[kind]) || null;
}

/** Whether ANY real Togo GLB is wired (so the View can flag "real models on"). */
export function hasTogoGlb() {
  return Object.keys(TOGO_GLB).length > 0;
}
