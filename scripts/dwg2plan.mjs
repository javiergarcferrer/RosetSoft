/**
 * dwg2plan — turn Ligne Roset Togo CAD blocks into the configurator's web assets.
 *
 * Input : scripts/togo-dwg/togo_<id>.dwg  (AutoCAD 2013 blocks; cm; INSUNITS=5)
 * Output: src/assets/togo/togo_<id>.svg   (clean top-down plan symbol)
 *         src/assets/togo/pieces.js        (pure metadata: footprint + labels)
 *
 * HOW IT WORKS (and why it's safe to re-run):
 *   The model space holds only INSERTs; the real geometry lives in BLOCK_RECORDs,
 *   organised onto layers. Ligne Roset authored a dedicated "Mobilier 2D" layer —
 *   the architect's top-down plan symbol — so we resolve INSERT→block recursively,
 *   apply each insert's affine transform, keep ONLY that layer, and project to XY.
 *   Output is normalised: viewBox = the real cm footprint, stroke = currentColor
 *   (so the app themes it), all strokes merged into ONE <path> to keep the file
 *   small. The libredwg WASM parser is a BUILD-TIME tool only — it never ships to
 *   the browser; the committed .svg + pieces.js are what the app imports.
 *
 * Run:  node scripts/dwg2plan.mjs      (needs the @mlightcad/libredwg-web devDep)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const IN_DIR = join(HERE, 'togo-dwg');
const OUT_DIR = join(ROOT, 'src', 'assets', 'togo');
const WASM = join(ROOT, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm/');
const PLAN_LAYER = 'Mobilier 2D';

// Per-piece presentation + matching metadata (footprint cm is MEASURED, not set
// here). Keyed by the DWG file stem. `match` keywords let the app auto-bind a
// piece to a Togo model in the live catalog (any language the dealer named it).
const META = {
  togo_a:      { id: 'a',      label: 'Sillón Togo',        model: 'armchair',     order: 2, match: ['togo', 'fauteuil', 'armchair', 'sillon', 'butaca'] },
  togo_chauf:  { id: 'chauf',  label: 'Chofesa Togo',       model: 'fireside',     order: 1, match: ['togo', 'chauffeuse', 'fireside', 'chofesa', 'sin brazos'] },
  togo_gb:     { id: 'gb',     label: 'Sofá Togo',          model: 'settee',       order: 3, match: ['togo', 'settee', 'sofa', 'canape', 'canapé', '2'] },
  togo_mc:     { id: 'mc',     label: 'Sofá grande Togo',   model: 'large-settee', order: 4, match: ['togo', 'grand', 'large', 'grande', '3'] },
  togo_lounge: { id: 'lounge', label: 'Meridiana Togo',     model: 'lounge',       order: 5, match: ['togo', 'lounge', 'meridienne', 'chaise', 'meridiana', 'angle', 'corner'] },
};

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

// Collect plan-layer geometry from one block's entities, transformed to world.
function collect(ents, m, blocks, polys, circles, depth = 0) {
  for (const e of ents || []) {
    if (e.type === 'INSERT') {
      const br = blocks[e.name];
      if (br && depth < 12) collect(br.entities || [], mul(m, insertMatrix(e, br.basePoint)), blocks, polys, circles, depth + 1);
      continue;
    }
    if (e.layer !== PLAN_LAYER) continue;
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
}

const libredwg = await LibreDwg.create(WASM);
const files = readdirSync(IN_DIR).filter((f) => f.endsWith('.dwg'));
const pieces = [];

for (const file of files) {
  const stem = file.replace(/\.dwg$/, '');
  const meta = META[stem];
  if (!meta) { console.warn('skip (no metadata):', file); continue; }

  const dwg = libredwg.dwg_read_data(new Uint8Array(readFileSync(join(IN_DIR, file))), Dwg_File_Type.DWG);
  const db = libredwg.convert(dwg);
  const blocks = {};
  for (const br of (db.tables?.BLOCK_RECORD?.entries || [])) blocks[br.name] = br;
  const polys = [], circles = [];
  collect(db.entities || [], I, blocks, polys, circles);
  libredwg.dwg_free(dwg);

  // Footprint (cm) from the plan-layer extent.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (p) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
  for (const s of polys) s.pts.forEach(grow);
  for (const c of circles) { grow({ x: c.c.x - c.r, y: c.c.y - c.r }); grow({ x: c.c.x + c.r, y: c.c.y + c.r }); }
  const wCm = Math.round(maxX - minX), hCm = Math.round(maxY - minY);

  // Project to viewBox space (origin top-left, Y down), merge into ONE path.
  const fx = (x) => +(x - minX).toFixed(2);
  const fy = (y) => +(maxY - y).toFixed(2);
  let d = '';
  for (const s of polys) {
    d += s.pts.map((p, i) => `${i ? 'L' : 'M'}${fx(p.x)} ${fy(p.y)}`).join('') + (s.closed ? 'Z' : '');
  }
  const circEls = circles.map((c) => `<circle cx="${fx(c.c.x)}" cy="${fy(c.c.y)}" r="${+c.r.toFixed(2)}"/>`).join('');
  const sw = +(Math.max(wCm, hCm) / 320).toFixed(2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wCm} ${hCm}" fill="none" `
    + `stroke="currentColor" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round">`
    + `<path d="${d}"/>${circEls}</svg>\n`;

  writeFileSync(join(OUT_DIR, `${stem}.svg`), svg);
  pieces.push({ ...meta, widthCm: wCm, depthCm: hCm, svgFile: `${stem}.svg`, paths: polys.length, circles: circles.length });
  console.log(`${stem}: ${wCm}×${hCm} cm · ${polys.length} polylines · ${(svg.length / 1024).toFixed(1)} KB`);
}

// Stable order for the palette.
pieces.sort((a, b) => a.order - b.order);
const body = pieces.map((p) =>
  `  { id: ${JSON.stringify(p.id)}, label: ${JSON.stringify(p.label)}, model: ${JSON.stringify(p.model)}, `
  + `widthCm: ${p.widthCm}, depthCm: ${p.depthCm}, svgFile: ${JSON.stringify(p.svgFile)}, match: ${JSON.stringify(p.match)} },`
).join('\n');
const piecesJs =
  `// GENERATED by scripts/dwg2plan.mjs from the Ligne Roset Togo CAD blocks — do not edit by hand.\n`
  + `// Footprints are MEASURED from each DWG's "Mobilier 2D" plan layer (centimetres).\n`
  + `// Pure metadata (no asset imports) so the ViewModel + tests can read it in Node.\n`
  + `export const TOGO_PIECES = [\n${body}\n];\n`;
writeFileSync(join(OUT_DIR, 'pieces.js'), piecesJs);
console.log(`\nWrote ${pieces.length} pieces → src/assets/togo/{*.svg,pieces.js}`);
