/**
 * Real Togo 3D models, keyed by piece FOOTPRINT ("WxD" in cm, e.g. "174x102")
 * — which is unique per Togo piece, so each of the dealer's pieces maps to its
 * own model — or, as a fallback, by canonical kind (chauf · a · gb · mc · lounge,
 * see pieces.js). EMPTY until the dealer exports the official Togo geometry and
 * drops the files in `public/togo-models/`.
 *
 * WHY this is empty: the source DWGs (scripts/togo-dwg/*.dwg, AutoCAD 2013 /
 * AC1027) DO carry the real 3D bodies on their "Mobilier 3D" layer — pCon
 * renders them — but our in-browser DWG reader (@mlightcad/libredwg-web) can't
 * decode AC1027 ACIS solids, and there's no CAD kernel in the build to tessellate
 * them. So the 3D view ships with procedural geometry (lib/togo/togoModel.js)
 * sized to the real footprints, and upgrades to these models the moment they
 * exist — no other code changes.
 *
 * HOW to add a model: in pCon.planner do File → Export and pick a mesh format
 * (the viewer loads **GLB/glTF, OBJ, FBX, 3DS, Collada .dae** directly). Drop the
 * file in `public/togo-models/` and add ONE entry below keyed by the piece's
 * footprint (matches the cm size shown in the palette):
 *   '174x102': { url: '/togo-models/sofa.fbx', scale: 0.1, upAxis: 'z' },
 * Fields (all but `url` optional): `scale` = drawing units → centimetres (pCon/
 * FBX exports are usually millimetres → 0.1); `upAxis: 'z'` if the export is Z-up
 * (CAD) rather than Y-up; `rotateY` (deg) to face the open front toward +Z. The
 * renderer auto-recentres + floors the model (origin doesn't matter) and re-skins
 * it in the chosen fabric — same as dragging a material in pCon.
 */
export const TOGO_GLB = {
  // '102x102': { url: '/togo-models/corner.fbx',  scale: 0.1, upAxis: 'z' },  // Togo Corner
  // '87x102':  { url: '/togo-models/fireside.fbx', scale: 0.1, upAxis: 'z' }, // Togo Fireside
  // '174x102': { url: '/togo-models/sofa.fbx',     scale: 0.1, upAxis: 'z' }, // Togo Sofa w/o Arms
  // '131x162': { url: '/togo-models/lounge.fbx',   scale: 0.1, upAxis: 'z' }, // Togo Lounge
  // '198x102': { url: '/togo-models/medium.fbx',   scale: 0.1, upAxis: 'z' }, // Togo Medium Sofa
  // '87x80':   { url: '/togo-models/ottoman.fbx',  scale: 0.1, upAxis: 'z' },  // Togo Ottoman
  // '131x102': { url: '/togo-models/loveseat.fbx', scale: 0.1, upAxis: 'z' }, // Togo Loveseat
};

/** The model descriptor for a placed piece — by footprint first (unique per
 *  piece), then by canonical kind — or null when no real model is wired. */
export function glbForPiece(piece) {
  if (!piece) return null;
  const fp = `${Math.round(Number(piece.widthCm) || 0)}x${Math.round(Number(piece.depthCm) || 0)}`;
  return TOGO_GLB[fp] || (piece.kind && TOGO_GLB[piece.kind]) || null;
}

/** The model descriptor for a canonical kind, or null. (Footprint keys win; this
 *  is the fallback lookup + what the tests pin.) */
export function glbFor(kind) {
  return (kind && TOGO_GLB[kind]) || null;
}

/** Whether ANY real Togo model is wired (so the View can flag "real models on"). */
export function hasTogoGlb() {
  return Object.keys(TOGO_GLB).length > 0;
}
