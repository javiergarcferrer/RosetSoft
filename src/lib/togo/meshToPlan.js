/**
 * Mesh → top-down plan. The FBX-native replacement for the DWG `planGeometry`
 * pipeline.
 *
 * Given the floor triangles of a loaded mesh — already projected to the XZ ground
 * plane and scaled to centimetres — it rasterises their UNION into an occupancy
 * grid, traces the boundary into closed loops, simplifies them, and emits a plan
 * SVG in the SAME shape the old `planToSvg` produced: `viewBox="0 0 width depth"`
 * (the viewBox IS the real cm footprint) and one themeable `<path>`
 * (stroke=currentColor). Because the viewBox equals the footprint, a piece's 2D
 * tile is literally its mesh seen from above and can never disagree with the 3D
 * — no letterbox, no dead space, at any rotation.
 *
 * Pure (no three.js, no DOM) so it unit-tests off synthetic triangles.
 *
 * @param tris  Float array (or number[]) of XZ vertices in cm, 6 per triangle:
 *              [ax,az, bx,bz, cx,cz, …].
 * @returns { svg, widthCm, depthCm, triCount, loops }
 */
export function meshPlanFromTriangles(tris, opts = {}) {
  const n = tris ? tris.length : 0;
  if (n < 6) return EMPTY;

  // 1) Footprint bbox.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 1 < n; i += 2) {
    const x = tris[i], z = tris[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const wCm = maxX - minX, dCm = maxZ - minZ;
  if (!(wCm > 0) || !(dCm > 0)) return EMPTY;

  // 2) Occupancy grid (~`grid` cells on the longer side), exact cell size in cm.
  const target = Math.max(24, Math.min(360, opts.grid || 170));
  const cellTarget = Math.max(wCm, dCm) / target;
  const gw = Math.max(1, Math.round(wCm / cellTarget));
  const gh = Math.max(1, Math.round(dCm / cellTarget));
  const cx = wCm / gw, cz = dCm / gh;
  const occ = new Uint8Array(gw * gh);

  for (let t = 0; t + 5 < n; t += 6) {
    const ax = tris[t] - minX, az = tris[t + 1] - minZ;
    const bx = tris[t + 2] - minX, bz = tris[t + 3] - minZ;
    const ux = tris[t + 4] - minX, uz = tris[t + 5] - minZ;
    const area = (bx - ax) * (uz - az) - (bz - az) * (ux - ax);
    if (area > -1e-9 && area < 1e-9) continue;                  // degenerate
    const sgn = area > 0 ? 1 : -1;
    let gx0 = Math.floor(Math.min(ax, bx, ux) / cx), gx1 = Math.floor(Math.max(ax, bx, ux) / cx);
    let gz0 = Math.floor(Math.min(az, bz, uz) / cz), gz1 = Math.floor(Math.max(az, bz, uz) / cz);
    if (gx0 < 0) gx0 = 0; if (gz0 < 0) gz0 = 0;
    if (gx1 >= gw) gx1 = gw - 1; if (gz1 >= gh) gz1 = gh - 1;
    for (let gz = gz0; gz <= gz1; gz++) {
      const pz = (gz + 0.5) * cz, row = gz * gw;
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = (gx + 0.5) * cx;
        const e1 = ((bx - ax) * (pz - az) - (bz - az) * (px - ax)) * sgn;
        const e2 = ((ux - bx) * (pz - bz) - (uz - bz) * (px - bx)) * sgn;
        const e3 = ((ax - ux) * (pz - uz) - (az - uz) * (px - ux)) * sgn;
        if (e1 >= 0 && e2 >= 0 && e3 >= 0) occ[row + gx] = 1;
      }
    }
  }

  // 3) Directed boundary edges (occupied region kept on the LEFT → CCW outer
  //    loops, CW holes), so following each vertex's outgoing edge traces loops.
  const isOcc = (gx, gz) => gx >= 0 && gz >= 0 && gx < gw && gz < gh && occ[gz * gw + gx] === 1;
  const stride = gh + 1;
  const out = new Map();                                        // fromKey → toKey[]
  const link = (ax, az, bx, bz) => {
    const f = ax * stride + az, tk = bx * stride + bz;
    const a = out.get(f); if (a) a.push(tk); else out.set(f, [tk]);
  };
  for (let gz = 0; gz < gh; gz++) {
    for (let gx = 0; gx < gw; gx++) {
      if (occ[gz * gw + gx] !== 1) continue;
      if (!isOcc(gx, gz - 1)) link(gx + 1, gz, gx, gz);          // top
      if (!isOcc(gx, gz + 1)) link(gx, gz + 1, gx + 1, gz + 1);  // bottom
      if (!isOcc(gx - 1, gz)) link(gx, gz, gx, gz + 1);          // left
      if (!isOcc(gx + 1, gz)) link(gx + 1, gz + 1, gx + 1, gz);  // right
    }
  }
  if (out.size === 0) return { ...EMPTY, widthCm: Math.round(wCm), depthCm: Math.round(dCm) };

  // 4) Trace + simplify loops; emit one path in cm space (0..w, 0..d).
  const eps = Math.max(cx, cz) * 0.9;
  const toPt = (k) => ({ x: Math.floor(k / stride) * cx, y: (k % stride) * cz });
  let d = '';
  for (const from of [...out.keys()]) {
    let arr = out.get(from);
    while (arr && arr.length) {
      const loop = [from];
      let cur = arr.pop();
      let guard = 0;
      while (cur !== from && guard++ < 4_000_000) {
        loop.push(cur);
        const nx = out.get(cur);
        if (!nx || !nx.length) break;
        cur = nx.pop();
      }
      if (loop.length >= 4) {
        const poly = simplifyClosed(loop.map(toPt), eps);
        if (poly.length >= 3) {
          d += poly.map((p, i) => `${i ? 'L' : 'M'}${round2(p.x)} ${round2(p.y)}`).join('') + 'Z';
        }
      }
      arr = out.get(from);
    }
  }
  if (!d) return { ...EMPTY, widthCm: Math.round(wCm), depthCm: Math.round(dCm) };

  const W = Math.round(wCm), D = Math.round(dCm);
  const sw = +(Math.max(W, D) / 320 || 0.3).toFixed(2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${D}" fill="none" `
    + `stroke="currentColor" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round">`
    + `<path d="${d}"/></svg>`;
  return { svg, widthCm: W, depthCm: D, triCount: (n / 6) | 0, loops: (d.match(/M/g) || []).length };
}

const EMPTY = { svg: '', widthCm: 0, depthCm: 0, triCount: 0, loops: 0 };
const round2 = (v) => +v.toFixed(2);

// Perpendicular distance of p from the segment a→b.
function perp(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) { const ux = p.x - a.x, uy = p.y - a.y; return Math.hypot(ux, uy); }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  const qx = a.x + t * dx, qy = a.y + t * dy;
  return Math.hypot(p.x - qx, p.y - qy);
}

// Douglas–Peucker on an OPEN polyline (keeps both ends).
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let dmax = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const dd = perp(pts[i], a, b);
    if (dd > dmax) { dmax = dd; idx = i; }
  }
  if (dmax > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

// Simplify a CLOSED loop: rotate to its bottom-left extreme (a stable anchor that
// won't be simplified away), run DP open with the start re-appended, drop the dup.
function simplifyClosed(loop, eps) {
  if (loop.length < 4) return loop;
  let s = 0;
  for (let i = 1; i < loop.length; i++) {
    if (loop[i].x < loop[s].x || (loop[i].x === loop[s].x && loop[i].y < loop[s].y)) s = i;
  }
  const rot = loop.slice(s).concat(loop.slice(0, s));
  rot.push({ ...rot[0] });
  const out = rdp(rot, eps);
  out.pop();
  return out;
}
