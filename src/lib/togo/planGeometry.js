/**
 * Togo plan geometry — the PURE core of the DWG → top-down-SVG conversion.
 *
 * It operates on an ALREADY-PARSED libredwg "DwgDatabase" (a plain object: tables,
 * entities, header), so it imports NO wasm and NO libredwg — which lets it run in
 * three places off ONE implementation:
 *   • the in-browser uploader  (src/lib/togo/dwgToPlan.js adds the wasm load),
 *   • the build script         (scripts/dwg2plan.mjs, for the seeded assets),
 *   • unit tests.
 *
 * The Togo CAD blocks keep their geometry in BLOCK_RECORDs (model space holds only
 * INSERTs) organised onto layers; Ligne Roset authored a dedicated top-down plan
 * layer ("Mobilier 2D"). We resolve INSERT→block recursively, apply each insert's
 * affine transform, keep only that layer, project to XY, and merge every stroke
 * into ONE <path> (stroke=currentColor, so the app themes it). viewBox = the real
 * cm footprint, so a tile's box equals its footprint. Centimetres throughout.
 */

export const PLAN_LAYER = 'Mobilier 2D';

// ── 2D affine matrix [a,b,c,d,e,f]: x'=a·x+c·y+e, y'=b·x+d·y+f ──
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

function insertMatrix(ins, base) {
  const t = ins.rotation || 0, c = Math.cos(t), s = Math.sin(t);
  const sx = ins.xScale ?? 1, sy = ins.yScale ?? 1;
  const ip = ins.insertionPoint || { x: 0, y: 0 }, bp = base || { x: 0, y: 0 };
  const T = [1, 0, 0, 1, ip.x, ip.y], R = [c, s, -s, c, 0, 0];
  const S = [sx, 0, 0, sy, 0, 0], Tb = [1, 0, 0, 1, -bp.x, -bp.y];
  return mul(mul(mul(T, R), S), Tb);
}

/** Recursively collect plan-layer polylines + circles, transformed to world XY. */
export function collectPlan(db, layer = PLAN_LAYER) {
  const blocks = {};
  for (const br of (db?.tables?.BLOCK_RECORD?.entries || [])) blocks[br.name] = br;
  const polys = [], circles = [];

  const recurse = (ents, m, depth) => {
    for (const e of ents || []) {
      if (e.type === 'INSERT') {
        const br = blocks[e.name];
        if (br && depth < 12) recurse(br.entities || [], mul(m, insertMatrix(e, br.basePoint)), depth + 1);
        continue;
      }
      if (layer && e.layer !== layer) continue;
      const P = (p) => apply(m, p.x, p.y);
      switch (e.type) {
        case 'LINE': polys.push({ pts: [P(e.startPoint), P(e.endPoint)], closed: false }); break;
        case 'LWPOLYLINE': case 'POLYLINE2D': case 'POLYLINE3D':
          if (e.vertices?.length) polys.push({ pts: e.vertices.map(P), closed: !!(e.flag & 1) }); break;
        case 'ARC': {
          const r = e.radius, ce = e.center, a0 = e.startAngle ?? 0, a1 = e.endAngle ?? Math.PI * 2, N = 28, pts = [];
          for (let i = 0; i <= N; i++) { const a = a0 + (a1 - a0) * i / N; pts.push(P({ x: ce.x + r * Math.cos(a), y: ce.y + r * Math.sin(a) })); }
          polys.push({ pts, closed: false }); break;
        }
        case 'CIRCLE': { const c = P(e.center); circles.push({ c, r: Math.abs(e.radius * m[0]) }); break; }
        case 'SPLINE': { const cps = e.fitPoints?.length ? e.fitPoints : (e.controlPoints || []); if (cps.length) polys.push({ pts: cps.map(P), closed: false }); break; }
        default: break;
      }
    }
  };
  recurse(db?.entities || [], I, 0);
  return { polys, circles };
}

/** Merge collected geometry into a normalised top-down SVG + its cm footprint. */
export function planToSvg(polys, circles) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (p) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
  for (const s of polys) s.pts.forEach(grow);
  for (const c of circles) { grow({ x: c.c.x - c.r, y: c.c.y - c.r }); grow({ x: c.c.x + c.r, y: c.c.y + c.r }); }
  if (!Number.isFinite(minX)) return { svg: '', widthCm: 0, depthCm: 0 };

  const widthCm = Math.round(maxX - minX), depthCm = Math.round(maxY - minY);
  const fx = (x) => +(x - minX).toFixed(2);
  const fy = (y) => +(maxY - y).toFixed(2);
  let d = '';
  for (const s of polys) d += s.pts.map((p, i) => `${i ? 'L' : 'M'}${fx(p.x)} ${fy(p.y)}`).join('') + (s.closed ? 'Z' : '');
  const circEls = circles.map((c) => `<circle cx="${fx(c.c.x)}" cy="${fy(c.c.y)}" r="${+c.r.toFixed(2)}"/>`).join('');
  const sw = +(Math.max(widthCm, depthCm) / 320 || 0.3).toFixed(2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthCm} ${depthCm}" fill="none" `
    + `stroke="currentColor" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round">`
    + `<path d="${d}"/>${circEls}</svg>`;
  return { svg, widthCm, depthCm };
}

/** Full pipeline over a parsed DwgDatabase → { svg, widthCm, depthCm, layer }. */
export function planFromDb(db, { layer = PLAN_LAYER } = {}) {
  const { polys, circles } = collectPlan(db, layer);
  return { ...planToSvg(polys, circles), layer, polyCount: polys.length };
}
