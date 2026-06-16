/**
 * Real Togo 3D models, keyed by canonical piece kind (chauf · a · gb · mc ·
 * lounge — see pieces.js). EMPTY until the dealer exports the official Togo
 * geometry and drops the files in `public/togo-models/`.
 *
 * WHY this is empty: the source DWGs (scripts/togo-dwg/*.dwg, AutoCAD 2013 /
 * AC1027) DO carry the real 3D bodies on their "Mobilier 3D" layer — pCon
 * renders them — but our in-browser DWG reader (@mlightcad/libredwg-web) can't
 * decode AC1027 ACIS solids, and there's no CAD kernel in the build to tessellate
 * them. So the 3D view ships with procedural geometry (lib/togo/togoModel.js)
 * sized to the real footprints, and upgrades to these models the moment they
 * exist — no other code changes.
 *
 * HOW pCon gives you the file: pCon already tessellates the DWG, so in
 * pCon.planner do File → Export and pick a mesh format. The viewer loads
 * **GLB/glTF, OBJ, FBX, 3DS, and Collada (.dae)** directly (three.js loaders).
 * Put the file at public/togo-models/<id>.<ext> and add an entry:
 *   a: { url: '/togo-models/a.obj', scale: 0.1, upAxis: 'z' },
 * Fields (all but `url` optional): `scale` = drawing units → centimetres (pCon
 * exports are often millimetres → 0.1); `upAxis: 'z'` if the export is Z-up
 * (CAD) rather than Y-up; `rotateY` (deg) to face the open front toward +Z. The
 * renderer recentres + floors the model, so its origin doesn't matter, and
 * re-skins it in the chosen fabric (same as dragging a material in pCon).
 */
export const TOGO_GLB = {
  // chauf: { url: '/togo-models/chauf.obj', scale: 0.1, upAxis: 'z' },
  // a:     { url: '/togo-models/a.glb', scale: 1 },
  // gb:    { url: '/togo-models/gb.fbx', scale: 0.1 },
  // mc:    { url: '/togo-models/mc.obj', scale: 0.1, upAxis: 'z' },
  // lounge:{ url: '/togo-models/lounge.dae', scale: 1 },
};

/** The model descriptor for a kind, or null when no real model is wired yet. */
export function glbFor(kind) {
  return (kind && TOGO_GLB[kind]) || null;
}

/** Whether ANY real Togo model is wired (so the View can flag "real models on"). */
export function hasTogoGlb() {
  return Object.keys(TOGO_GLB).length > 0;
}
