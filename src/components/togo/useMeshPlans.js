import { useEffect, useState } from 'react';
import { loadMeshPlan } from '../../lib/togo/meshPlanCache.js';
import { renderMeshTopDown } from './meshTopDownRender.js';

/**
 * Derive each mesh-backed Togo piece's top-down plan + footprint STRAIGHT FROM ITS
 * FBX (loaded once, cached per URL by meshPlanCache), keyed by model id. The FBX is
 * the single source for both the 2D tile and the 3D view, so they can never
 * disagree; the stored DWG plan is only the fallback shown while the mesh loads.
 *
 * @param entries `[{ id, url, upAxis }]` — one per model (skip those with no url).
 * @returns `{ [id]: { svg, widthCm, depthCm } }`, filling in as meshes resolve.
 */
export function useMeshPlans(entries) {
  const [plans, setPlans] = useState({});
  // Effect identity keyed on the (id,url,axis) tuples so it re-runs only when the
  // mesh set actually changes, not on every render's fresh array.
  const key = (entries || []).map((e) => `${e?.id}:${e?.url || ''}:${e?.upAxis || 'y'}`).join('|');
  useEffect(() => {
    let alive = true;
    for (const e of (entries || [])) {
      if (!e?.id || !e?.url) continue;
      loadMeshPlan(e.url, { upAxis: e.upAxis || 'y' })
        .then((plan) => {
          if (!alive || !plan?.svg) return;
          setPlans((prev) => (prev[e.id]?.svg === plan.svg ? prev : { ...prev, [e.id]: plan }));
        })
        .catch(() => { /* keep the stored fallback */ });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return plans;
}

/**
 * Realistic top-down renders of each placed piece (the FBX shot from above with
 * shadows), keyed by model id. Needs the footprint, so callers pass dims resolved
 * from the mesh plan. Fills in as renders complete; tiles fall back to the
 * silhouette until (or unless) a render arrives.
 *
 * @param entries `[{ id, url, upAxis, rotateY, scale, widthCm, depthCm, form }]`.
 * @returns `{ [id]: { dataUrl, margin } }`.
 */
export function useTopDownTiles(entries) {
  const [imgs, setImgs] = useState({});
  const key = (entries || [])
    .map((e) => `${e?.id}:${e?.url || ''}:${e?.upAxis || 'y'}:${Math.round(e?.widthCm || 0)}x${Math.round(e?.depthCm || 0)}:${e?.fabricCode || ''}`)
    .join('|');
  useEffect(() => {
    let alive = true;
    for (const e of (entries || [])) {
      if (!e?.id || !e?.url || !(e.widthCm > 0) || !(e.depthCm > 0)) continue;
      renderMeshTopDown(e)
        .then((res) => {
          if (!alive || !res?.dataUrl) return;
          setImgs((prev) => (prev[e.id]?.dataUrl === res.dataUrl ? prev : { ...prev, [e.id]: res }));
        })
        .catch(() => { /* fall back to the silhouette */ });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return imgs;
}

/** Overlay FBX-derived plans onto a base svg/resolved map (the FBX wins). */
export function applyMeshPlans(meshPlans, baseSvgById, baseResolvedById) {
  const svgById = { ...baseSvgById };
  const resolvedById = {};
  for (const id of Object.keys(baseResolvedById || {})) {
    const mp = meshPlans[id];
    resolvedById[id] = mp ? { ...baseResolvedById[id], widthCm: mp.widthCm, depthCm: mp.depthCm } : baseResolvedById[id];
    if (mp?.svg) svgById[id] = mp.svg;
  }
  return { svgById, resolvedById };
}
