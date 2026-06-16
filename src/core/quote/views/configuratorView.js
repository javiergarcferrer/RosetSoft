// ViewModel — the Togo plan configurator.
//
// MVVM: a pure projection (no React, no db, no DOM) that turns a list of PLACED
// pieces (each a piece id + a cm position + a 90° rotation) into (a) the px tiles
// the canvas renders and (b) the SAME modular quote line the rest of the app
// already prices. The configurator invents NO pricing: a finished layout is a
// normal compound line whose modules are the placed pieces, so `compoundSubtotal`
// (the engine the editor/PDF/bridge use) is the single source for the subtotal —
// screen and the eventual quote can't diverge.
//
// Geometry lives entirely in centimetres (the unit the DWGs carry); only
// `resolveConfigurator` projects to px via `scale`. Snapping is trivial because
// every Togo piece shares the iconic 102 cm depth — pieces click flush on a grid.
import { compoundSubtotal } from '../../../lib/pricing.js';
import { groupFamilies, productForGrade } from '../../../lib/catalog.js';
import { composeSubtype } from '../../../lib/subtype.js';

// Plan canvas extent (cm) and the cm→px scale the View renders at. A Togo "room"
// of ~7.6 × 5.4 m comfortably holds an L- or U-shaped sectional.
export const PLAN_W_CM = 760;
export const PLAN_H_CM = 540;
export const PX_PER_CM = 1;
export const SNAP_GRID_CM = 2;   // free-ish fine grid every drag lands on
export const EDGE_SNAP_CM = 8;   // flush-to-neighbour threshold

const norm360 = (deg) => (((deg % 360) + 360) % 360);

/**
 * Admin "Modelos" projection: each saved model + its binding facts. A model's
 * bound STATE is a property of the row (`productRoot`), NOT of the loaded
 * catalog — so the list renders correct bound/unbound INSTANTLY from the (tiny)
 * togo_models query, without waiting on the thousands-of-SKUs products catalog.
 * When the catalog IS loaded (lazily, only to (re)bind), the family name + grade
 * count enrich each row; until then they're null and the View just shows
 * "Vinculado". Pure — no React, no db. `families` may be a root→family Map or an
 * array (empty/undefined while the catalog hasn't been loaded yet).
 */
export function resolveTogoModelCards(models, families) {
  const byRoot = families instanceof Map
    ? families
    : new Map((families || []).map((f) => [f.root, f]));
  return (models || [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''))
    .map((m) => {
      const root = m.productRoot || null;
      const fam = root ? byRoot.get(root) || null : null;
      return {
        id: m.id, name: m.name, svg: m.svg, widthCm: m.widthCm, depthCm: m.depthCm,
        sortOrder: m.sortOrder || 0,
        productRoot: root,
        bound: !!root,
        familyName: fam?.name || null,
        graded: !!fam?.graded,
        gradeCount: fam?.graded ? fam.grades.length : 0,
      };
    });
}

/**
 * The "bind to product" picker list — Togo families first, then the rest. Pure;
 * returns [] until the (lazily-loaded) catalog is available, so the View can show
 * a "Cargando catálogo…" affordance without faking options.
 */
export function togoPickerFamilies(products) {
  if (!products) return [];
  const isTogo = (f) => /togo/i.test(f.name || '');
  const all = groupFamilies(products).filter((f) => f.name);
  return [...all.filter(isTogo), ...all.filter((f) => !isTogo(f))]
    .sort((a, b) => (isTogo(b) - isTogo(a)) || (a.name || '').localeCompare(b.name || ''));
}

/**
 * Resolve the dealer's saved Togo models (`togo_models`) + the product catalog
 * into the configurator's palette: the active, drawable models sorted for
 * display, each merged with its catalog binding (cheapest grade → base price,
 * reference, subtype, dimensions). The SINGLE source the internal builder AND the
 * Solicitudes inbox (replaying a web request) read, so a placement prices the
 * same wherever it's resolved. Pure — no React, no db. Returns:
 *   { families, activeModels, resolvedById, svgById }
 */
export function resolveTogoModels(models, products) {
  const families = new Map();
  for (const f of groupFamilies(products || [])) families.set(f.root, f);
  const activeModels = (models || [])
    .filter((m) => m.active !== false && m.svg)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''));
  const resolvedById = {};
  const svgById = {};
  for (const m of activeModels) {
    svgById[m.id] = m.svg;
    const fam = m.productRoot ? families.get(m.productRoot) : null;
    let unitPrice = null; let reference = ''; let name = m.name; let subtype = ''; let dimensions = '';
    if (fam) {
      const grade = fam.graded ? fam.grades[0] : '';
      const p = productForGrade(fam, grade);
      if (p) {
        unitPrice = Number(p.priceUsd) || 0;
        reference = p.reference || '';
        name = p.name || fam.name || m.name;
        subtype = grade ? composeSubtype(grade, '') : (p.subtype || '');
        dimensions = p.dimensions || '';
      }
    }
    resolvedById[m.id] = {
      id: m.id, label: m.name, name, reference, subtype,
      widthCm: m.widthCm, depthCm: m.depthCm, root: m.productRoot || null,
      unitPrice, dimensions: dimensions || `${m.widthCm}×${m.depthCm} cm`,
    };
  }
  return { families, activeModels, resolvedById, svgById };
}

/** Footprint (cm) of a piece at a rotation — 90°/270° swap width and depth. */
export function footprintOf(piece, rot) {
  const swap = norm360(rot) % 180 !== 0;
  const w = swap ? piece.depthCm : piece.widthCm;
  const h = swap ? piece.widthCm : piece.depthCm;
  return { w: Number(w) || 0, h: Number(h) || 0 };
}

/**
 * Snap a candidate box `{x,y,w,h}` (cm, top-left origin) against the other placed
 * boxes: round to the grid, then — when the candidate shares a band with a
 * neighbour — pull the nearest pair of edges flush (within EDGE_SNAP_CM). Edge↔edge
 * over {left,right}×{left,right} covers BOTH a flush join (right→neighbour.left)
 * and an alignment (left→neighbour.left); same for the vertical axis. Pure.
 */
export function snapPlacement(cand, others = [], opts = {}) {
  const grid = opts.gridCm ?? SNAP_GRID_CM;
  const snap = opts.edgeCm ?? EDGE_SNAP_CM;
  let x = Math.round(cand.x / grid) * grid;
  let y = Math.round(cand.y / grid) * grid;
  const L = x, R = x + cand.w, T = y, B = y + cand.h;
  let bestDX = Infinity, dx = 0, bestDY = Infinity, dy = 0;
  for (const o of others) {
    const oL = o.x, oR = o.x + o.w, oT = o.y, oB = o.y + o.h;
    const vBand = T < oB && B > oT;   // overlap in Y → the X edges can meet
    const hBand = L < oR && R > oL;   // overlap in X → the Y edges can meet
    if (vBand) {
      for (const [e, t] of [[L, oL], [L, oR], [R, oL], [R, oR]]) {
        const d = t - e;
        if (Math.abs(d) <= snap && Math.abs(d) < bestDX) { bestDX = Math.abs(d); dx = d; }
      }
    }
    if (hBand) {
      for (const [e, t] of [[T, oT], [T, oB], [B, oT], [B, oB]]) {
        const d = t - e;
        if (Math.abs(d) <= snap && Math.abs(d) < bestDY) { bestDY = Math.abs(d); dy = d; }
      }
    }
  }
  return { x: x + dx, y: y + dy };
}

/** Clamp a box's top-left so the whole footprint stays inside the plan. */
export function clampToPlan(x, y, w, h, planW = PLAN_W_CM, planH = PLAN_H_CM) {
  return {
    x: Math.max(0, Math.min(x, Math.max(0, planW - w))),
    y: Math.max(0, Math.min(y, Math.max(0, planH - h))),
  };
}

/**
 * Build the compound line's COMPONENTS from the placed pieces — one component per
 * piece, each its OWN module (a Togo "complete element"), so the line reads as a
 * MODULAR product (per-component `moduleGroup` is what `isModularLine` keys on —
 * no `compoundKind` column needed). The plan geometry rides inline on the JSONB
 * component (`plan`), so the layout round-trips with the quote — no migration.
 * `resolved` is the piece merged with its catalog binding: { label, name,
 * reference, subtype, dimensions, unitPrice, widthCm, depthCm }.
 */
// A placement's facts = its model's defaults overlaid with the per-placement
// material pick (a chosen fabric reprices the unit + restamps subtype/swatch).
export function resolvePlacement(p, resolvedById) {
  return { ...(resolvedById[p.pieceId] || {}), ...(p.material || {}) };
}

export function buildTogoComponents(placed, resolvedById, newId) {
  return (placed || []).map((p) => {
    const r = resolvePlacement(p, resolvedById);
    const wCm = Number(r.widthCm) || 0;
    const dCm = Number(r.depthCm) || 0;
    return {
      id: newId(),
      name: r.name || r.label || 'Togo',
      reference: r.reference || '',
      subtype: r.subtype || '',
      dimensions: r.dimensions || (wCm && dCm ? `${wCm}×${dCm} cm` : ''),
      qty: 1,
      unitPrice: Number(r.unitPrice) || 0,
      swatchImageId: r.swatchImageId ?? null,
      moduleGroup: newId(),
      moduleName: r.label || r.name || 'Togo',
      plan: { pieceId: p.pieceId, x: p.x, y: p.y, rot: norm360(p.rot), widthCm: wCm, depthCm: dCm },
    };
  });
}

/** The quote-line seed for "Crear cotización": a modular Togo line. */
export function buildTogoModularSeed(placed, resolvedById, newId) {
  return {
    family: 'Togo',
    name: 'Togo — configuración',
    components: buildTogoComponents(placed, resolvedById, newId),
  };
}

/**
 * Project placed pieces → render-ready tiles + the running subtotal. The subtotal
 * is `compoundSubtotal` of the very line "Crear cotización" would create, so the
 * configurator and the quote agree to the cent. `scale` is px-per-cm.
 */
export function resolveConfigurator(placed, resolvedById, opts = {}) {
  const scale = opts.scale ?? PX_PER_CM;
  const planW = opts.planWCm ?? PLAN_W_CM;
  const planH = opts.planHCm ?? PLAN_H_CM;
  let seq = 0;
  const idOf = () => `t${seq++}`;
  const components = buildTogoComponents(placed, resolvedById, idOf);

  const tiles = (placed || []).map((p, i) => {
    const r = resolvePlacement(p, resolvedById);
    const rot = norm360(p.rot);
    const fp = footprintOf(r, rot);
    const wCm = Number(r.widthCm) || 0;
    const dCm = Number(r.depthCm) || 0;
    return {
      uid: p.uid,
      pieceId: p.pieceId,
      rot,
      label: r.label || r.name || 'Togo',
      widthCm: wCm,
      depthCm: dCm,
      dimsLabel: wCm && dCm ? `${wCm}×${dCm}` : '',
      swatchImageId: r.swatchImageId ?? null,
      fabric: r.fabric || '',
      priceUsd: Number(r.unitPrice) || 0,
      hasPrice: r.unitPrice != null && Number.isFinite(Number(r.unitPrice)) && Number(r.unitPrice) > 0,
      leftPx: p.x * scale,
      topPx: p.y * scale,
      wPx: fp.w * scale,
      hPx: fp.h * scale,
      // The svg fills an UNrotated box centred in the tile, then rotates — so the
      // tile's layout box always equals the footprint the snapping math used.
      innerWPx: (Number(r.widthCm) || 0) * scale,
      innerHPx: (Number(r.depthCm) || 0) * scale,
      // True once a piece pokes outside the plan (the View flags it).
      overflow: p.x < 0 || p.y < 0 || (p.x + fp.w) > planW || (p.y + fp.h) > planH,
    };
  });

  return {
    scale,
    canvas: { wPx: planW * scale, hPx: planH * scale },
    tiles,
    count: tiles.length,
    subtotalUsd: compoundSubtotal({ components }),
    priced: tiles.every((t) => t.hasPrice),
  };
}
