// quote-share/pick.ts — the pure pick REDUCER (the Model), one half of a rule
// that lives at two layers across the Deno↔Vite wall:
//
//   • CLIENT layer  — src/core/quote/actions.js `applyAction`: reduces the
//     client-facing BUNDLE (camelCase, margin baked in, per-option `delta`s
//     precomputed). Reprices by arithmetic (`unit + delta`). Optimistic UI.
//   • SERVER layer  — THIS file: reduces the persisted `quote_lines` ROWS
//     (snake_case columns; camelCase JSONB components) and reprices from the
//     CATALOG. Authoritative; its output is written to the DB.
//
// They are NOT one function in two runtimes — they reduce different shapes of
// the same domain (the source-of-truth rows vs their client-facing projection).
// What MUST stay identical is the RULE: which alternative member ends selected,
// which optional folds in/out, how a material re-anchors (subtype, reference,
// swatch, range cleared), and the validation gates (offered grades, offered
// optionals, group membership). That equivalence is pinned by
// tests/quotePickParity.test.js, which runs THIS reducer and the client's
// `applyAction` over one shared corpus. Edit a rule here → edit it there; the
// test goes red if they drift.
//
// Pure: no Deno, no I/O, no URL imports — so the Node/tsx parity test can import
// it directly. The imperative shell (index.ts) does auth + reads + the catalog
// price fetch + persistence, then calls this; prices arrive pre-resolved in
// `priceMap`, mirroring how the client receives pre-baked `delta`s.

type Row = Record<string, unknown>;

export interface GradeInfo { price: number; cost: number }

export interface Picks {
  alternatives?: Record<string, unknown>;
  optionals?: Record<string, unknown>;
  materials?: Record<string, unknown>;
  // The client-link FULL catalog picker: set a line/component to ANY fabric the
  // model has a catalog SKU for, identified by { grade, fabric, swatchImageId }
  // (the same shape SwatchPicker hands the editor). Distinct from `materials`,
  // which only re-anchors among the dealer's pre-offered grades. An EMPTY grade
  // clears the fabric instead — revert to the model's price range.
  materialPick?: Record<string, unknown>;
}

interface FreePick { grade?: unknown; fabric?: unknown; swatchImageId?: unknown }

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// 8-digit family root of an upholstered SKU ("15420000G" -> "15420000").
export function rootOf(ref: unknown): string | null {
  const m = /^(\d{8})[A-Za-z]$/.exec(String(ref || '').trim());
  return m ? m[1] : null;
}

// Grade taxonomy + canonical subtype composer, mirrored from src/lib/subtype.ts
// so a material switch writes the SAME "Grade X — Fabric" string the editor would
// (T/Y/Z are intentionally absent from the price list).
const ALPHA_GRADES = new Set(
  'A B C D E F G H I J K L M N O P Q R S U V W X'.split(' '),
);

// The model-link storage key for a SIMPLE line's reference — mirrors the client's
// splitSkuGrade(...).root (src/lib/catalog.ts): an "8-digit + grade letter" SKU
// collapses to its 8-digit family root; anything else (a non-graded or custom
// reference) stays whole. Distinct from rootOf (numeric-only, for catalog price
// lookups): a model link can sit on a non-graded reference too, and quoteShare
// must read the allowlist under the SAME key the editor stored it. Pinned to
// splitSkuGrade by tests/quotePickParity.test.js.
export function familyRootOf(ref: unknown): string {
  const s = String(ref || '').trim();
  const m = /^(\d{8})([A-Za-z])$/.exec(s);
  return m && ALPHA_GRADES.has(m[2].toUpperCase()) ? m[1] : s;
}

function composeSubtype(grade: string, fabric: string): string {
  const g = (grade || '').trim();
  const f = (fabric || '').trim();
  if (!g && !f) return '';
  if (!g) return f;
  const gradeStr = ALPHA_GRADES.has(g.toUpperCase()) ? `Grade ${g.toUpperCase()}` : g;
  return f ? `${gradeStr} — ${f}` : gradeStr;
}

// Re-anchor a materialOptions blob so `pickedGrade` becomes the base (the
// chosen material). The old base is demoted into the options list carrying the
// entity's CURRENT swatch, so switching back later keeps that swatch. Returns
// null when the grade isn't offered (a stale/invalid pick — leave untouched).
function reanchor(
  mo: { baseGrade?: unknown; baseLabel?: unknown; options?: unknown[] } | null | undefined,
  pickedGrade: string,
  currentSwatchId: unknown,
): { newMo: Record<string, unknown>; label: string; newSwatchId: unknown } | null {
  if (!mo) return null;
  const options = Array.isArray(mo.options) ? mo.options as Record<string, unknown>[] : [];
  if (String(mo.baseGrade) === pickedGrade) {
    return { newMo: mo as Record<string, unknown>, label: String(mo.baseLabel ?? ''), newSwatchId: currentSwatchId ?? null };
  }
  const picked = options.find((o) => String(o.grade) === pickedGrade);
  if (!picked) return null;
  const oldBase = { grade: mo.baseGrade, label: mo.baseLabel ?? '', code: null, swatchImageId: currentSwatchId ?? null };
  const newOptions = options.filter((o) => String(o.grade) !== pickedGrade).concat([oldBase]);
  return {
    newMo: { baseGrade: picked.grade, baseLabel: picked.label ?? '', options: newOptions },
    label: String(picked.label ?? ''),
    newSwatchId: picked.swatchImageId ?? null,
  };
}

// snake_case patch to switch a LINE's own material to `grade`.
function lineMaterialPatch(
  line: Row,
  grade: string,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Row | null {
  const r = reanchor(line.material_options as Row, grade, line.swatch_image_id);
  if (!r) return null;
  const root = rootOf(line.reference);
  const info = root ? priceMap.get(root)?.get(grade.toUpperCase()) : null;
  const patch: Row = {
    material_options: r.newMo,
    swatch_image_id: r.newSwatchId,
    subtype: composeSubtype(grade, r.label),
    // Picking a material resolves a material-less RANGE — drop it (the price is
    // now pinned), mirroring the editor's GradeFabricRow.commit.
    price_min: null,
    price_max: null,
  };
  if (root) patch.reference = root + grade.toUpperCase();
  if (info) { patch.unit_price = info.price; patch.unit_cost = info.cost; }
  return patch;
}

// Return a NEW component object with its material switched to `grade`.
function switchComponentMaterial(
  comp: Row,
  grade: string,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Row {
  const r = reanchor(comp.materialOptions as Row, grade, comp.swatchImageId);
  if (!r) return comp;
  const root = rootOf(comp.reference);
  const info = root ? priceMap.get(root)?.get(grade.toUpperCase()) : null;
  // Picking a material resolves a material-less RANGE — drop it (price pinned).
  const next: Row = { ...comp, materialOptions: r.newMo, swatchImageId: r.newSwatchId, subtype: composeSubtype(grade, r.label), priceMin: null, priceMax: null };
  if (root) next.reference = root + grade.toUpperCase();
  if (info) next.unitPrice = info.price;
  return next;
}

// Clamp a client-supplied fabric label — cosmetic free text from the picker, so
// cap its length defensively before it lands in `subtype`.
function cleanFabric(v: unknown): string {
  return String(v ?? '').slice(0, 200);
}

// The price RANGE a model spans across its catalog grades — cheapest→priciest
// price, plus the cheapest grade's cost (what a "sin material" line carries:
// unit_price/unit_cost = the cheapest grade). null when the root has fewer than
// two distinct prices (no range to form). The clear branch below reads this.
function rangeOf(
  root: string,
  priceMap: Map<string, Map<string, GradeInfo>>,
): { min: number; max: number; cost: number } | null {
  const grades = priceMap.get(root);
  if (!grades) return null;
  let cheapest: GradeInfo | null = null;
  let max = -Infinity;
  for (const info of grades.values()) {
    if (!Number.isFinite(info.price)) continue;
    if (cheapest == null || info.price < cheapest.price) cheapest = info;
    if (info.price > max) max = info.price;
  }
  if (cheapest == null || !(max > cheapest.price)) return null;
  return { min: cheapest.price, max, cost: cheapest.cost };
}

// snake_case patch that returns a LINE to its material-less RANGE — the recipient
// cleared the chosen fabric (empty grade). Mirrors the client's clearMaterial:
// subtype + swatch dropped, price/cost back to the cheapest grade,
// price_min..price_max the model's span. The reference is left as-is (still
// root-resolvable for a later re-pick; the range, not the reference, prices it).
// null when the model can't form a range — nothing to revert to.
function clearLineMaterial(
  root: string,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Row | null {
  const r = rangeOf(root, priceMap);
  if (!r) return null;
  return { subtype: '', swatch_image_id: null, unit_price: r.min, unit_cost: r.cost, price_min: r.min, price_max: r.max };
}

// camelCase mirror of clearLineMaterial for a COMPONENT (no separate cost on the
// sub-piece row, matching componentFreeMaterialPatch). Returns a NEW component.
function clearComponentMaterial(
  comp: Row,
  root: string,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Row | null {
  const r = rangeOf(root, priceMap);
  if (!r) return null;
  return { ...comp, subtype: '', swatchImageId: null, unitPrice: r.min, priceMin: r.min, priceMax: r.max };
}

// snake_case patch to set a LINE to an ARBITRARY catalog fabric+color (the
// client-link full picker). Price/cost come AUTHORITATIVELY from the model's SKU
// for the chosen grade; the fabric label + swatch are cosmetic. An EMPTY grade
// is the recipient CLEARING the fabric — revert to the model's range (see
// clearLineMaterial). Returns null when the model has no SKU for that grade (a
// stale/invalid pick — reject, never trust a client-supplied price). When the
// line carried dealer-offered alternatives we only re-base them
// (baseGrade/baseLabel) — GET recomputes each option's delta from the new base,
// so the strip stays consistent.
function lineFreeMaterialPatch(
  line: Row,
  sel: FreePick,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Row | null {
  const root = rootOf(line.reference);
  if (!root) return null;
  const grade = String(sel.grade ?? '').trim();
  if (!grade) return clearLineMaterial(root, priceMap);
  const info = priceMap.get(root)?.get(grade.toUpperCase());
  if (!info) return null;
  const fabric = cleanFabric(sel.fabric);
  const patch: Row = {
    reference: root + grade.toUpperCase(),
    subtype: composeSubtype(grade, fabric),
    swatch_image_id: sel.swatchImageId == null ? null : String(sel.swatchImageId),
    unit_price: info.price,
    unit_cost: info.cost,
    price_min: null,
    price_max: null,
  };
  const mo = line.material_options as { options?: unknown[] } | null | undefined;
  if (mo && Array.isArray(mo.options) && mo.options.length) {
    patch.material_options = { ...mo, baseGrade: grade.toUpperCase(), baseLabel: fabric };
  }
  return patch;
}

// camelCase patch for a COMPONENT (same rule as lineFreeMaterialPatch). Returns
// a NEW component object, or null to leave the sub-piece untouched.
function componentFreeMaterialPatch(
  comp: Row,
  sel: FreePick,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Row | null {
  const root = rootOf(comp.reference);
  if (!root) return null;
  const grade = String(sel.grade ?? '').trim();
  if (!grade) return clearComponentMaterial(comp, root, priceMap);
  const info = priceMap.get(root)?.get(grade.toUpperCase());
  if (!info) return null;
  const fabric = cleanFabric(sel.fabric);
  const next: Row = {
    ...comp,
    reference: root + grade.toUpperCase(),
    subtype: composeSubtype(grade, fabric),
    swatchImageId: sel.swatchImageId == null ? null : String(sel.swatchImageId),
    unitPrice: info.price,
    priceMin: null,
    priceMax: null,
  };
  const mo = comp.materialOptions as { options?: unknown[] } | null | undefined;
  if (mo && Array.isArray(mo.options) && mo.options.length) {
    next.materialOptions = { ...mo, baseGrade: grade.toUpperCase(), baseLabel: fabric };
  }
  return next;
}

interface LineIndex {
  lineById: Map<string, Row>;
  groupMembers: Map<string, Set<string>>;
  optionalIds: Set<string>;
  componentOptionalOffered: Set<string>;
  componentAltGroups: Map<string, { lineId: string; members: Set<string> }>;
  materialGrades: Map<string, Set<string>>;       // line OR component id → valid grades
  componentIndex: Map<string, { lineId: string }>; // component id → its line
}

// Build the validation/lookup indexes once from the raw rows. Lines the dealer
// OFFERED as toggleable optionals are gated on `optional_offered` (the stable
// designation), NOT `is_optional` (the current include state), so a toggled-in
// optional can be toggled back OUT. Component alternative groups + offered
// optionals are tracked one level down so a compound's sub-pieces pick through
// the same channels as top-level lines.
function indexLines(lineRows: Row[]): LineIndex {
  const lineById = new Map<string, Row>();
  const groupMembers = new Map<string, Set<string>>();
  const optionalIds = new Set<string>();
  const componentOptionalOffered = new Set<string>();
  const componentAltGroups = new Map<string, { lineId: string; members: Set<string> }>();
  const materialGrades = new Map<string, Set<string>>();
  const componentIndex = new Map<string, { lineId: string }>();
  const addMaterialTarget = (id: unknown, mo: { baseGrade?: unknown; options?: unknown[] } | null | undefined) => {
    if (!id || !mo || !Array.isArray(mo.options) || !mo.options.length) return;
    const set = new Set<string>();
    if (mo.baseGrade != null) set.add(String(mo.baseGrade));
    for (const o of mo.options) { const g = (o as { grade?: unknown })?.grade; if (g != null) set.add(String(g)); }
    if (set.size) materialGrades.set(String(id), set);
  };
  for (const l of lineRows) {
    const id = String(l.id);
    lineById.set(id, l);
    if (l.alternative_group) {
      const g = String(l.alternative_group);
      if (!groupMembers.has(g)) groupMembers.set(g, new Set());
      groupMembers.get(g)!.add(id);
    }
    if (l.optional_offered) optionalIds.add(id);
    addMaterialTarget(l.id, l.material_options as { baseGrade?: unknown; options?: unknown[] } | null);
    const comps = Array.isArray(l.components) ? l.components as Row[] : [];
    for (const c of comps) {
      if (c?.id != null) componentIndex.set(String(c.id), { lineId: id });
      if (c?.optionalOffered) componentOptionalOffered.add(String(c.id));
      if (c?.alternativeGroup != null && c?.id != null) {
        const g = String(c.alternativeGroup);
        if (!componentAltGroups.has(g)) componentAltGroups.set(g, { lineId: id, members: new Set() });
        componentAltGroups.get(g)!.members.add(String(c.id));
      }
      addMaterialTarget(c?.id, c?.materialOptions as { baseGrade?: unknown; options?: unknown[] } | null);
    }
  }
  return { lineById, groupMembers, optionalIds, componentOptionalOffered, componentAltGroups, materialGrades, componentIndex };
}

// Which catalog roots the material picks touch — so the shell fetches exactly
// those prices (the I/O stays in the shell; this decision is pure).
export function rootsForMaterialPicks(lineRows: Row[], body: Picks): Set<string> {
  const { lineById, materialGrades, componentIndex } = indexLines(lineRows);
  const matRoots = new Set<string>();
  for (const [id, grade] of Object.entries(body.materials || {})) {
    const key = String(id);
    if (!materialGrades.get(key)?.has(String(grade))) continue;
    if (lineById.has(key)) { const r = rootOf(lineById.get(key)!.reference); if (r) matRoots.add(r); }
    else if (componentIndex.has(key)) {
      const line = lineById.get(componentIndex.get(key)!.lineId);
      const comp = (line?.components as Row[] | undefined)?.find((c) => String(c.id) === key);
      const r = rootOf(comp?.reference); if (r) matRoots.add(r);
    }
  }
  // Free catalog picks — any grade the model has a SKU for is valid, so fetch the
  // whole touched root's prices (the grade is gated against the catalog later).
  for (const id of Object.keys(body.materialPick || {})) {
    const key = String(id);
    if (lineById.has(key)) { const r = rootOf(lineById.get(key)!.reference); if (r) matRoots.add(r); }
    else if (componentIndex.has(key)) {
      const line = lineById.get(componentIndex.get(key)!.lineId);
      const comp = (line?.components as Row[] | undefined)?.find((c) => String(c.id) === key);
      const r = rootOf(comp?.reference); if (r) matRoots.add(r);
    }
  }
  return matRoots;
}

// Apply the recipient's picks, returning one snake_case patch per touched line
// (component edits compose on a working copy of the line's components, so several
// picks on the same compound line merge). Validates every pick against what the
// dealer offered — an invalid/stale pick is silently ignored. `priceMap` is the
// pre-fetched catalog (root → grade → {price,cost}).
export function applyPicks(
  lineRows: Row[],
  body: Picks,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Map<string, Row> {
  const { lineById, groupMembers, optionalIds, componentOptionalOffered, componentAltGroups, materialGrades, componentIndex } = indexLines(lineRows);

  // Accumulate one patch per line, then the shell writes each once. Component
  // edits build on a working copy of the line's components so several picks on
  // the same compound line compose.
  const patches = new Map<string, Row>();
  const workingComps = new Map<string, Row[]>();
  const merge = (id: string, p: Row) => patches.set(id, { ...(patches.get(id) || {}), ...p });
  const compsOf = (lineId: string): Row[] => {
    if (!workingComps.has(lineId)) {
      const comps = lineById.get(lineId)?.components;
      workingComps.set(lineId, (Array.isArray(comps) ? comps as Row[] : []).map((c) => ({ ...c })));
    }
    return workingComps.get(lineId)!;
  };

  // Alternatives — only the chosen member of a group stays selected. The group
  // is a LINE alternative group or a COMPONENT one (inside a compound).
  for (const [group, pickedId] of Object.entries(body.alternatives || {})) {
    const members = groupMembers.get(group);
    if (members) {
      if (!members.has(String(pickedId))) continue;
      for (const memberId of members) merge(memberId, { is_selected_alternative: memberId === String(pickedId) });
      continue;
    }
    // Component-level alternative group → flip isSelectedAlternative on the
    // line's working components copy (composes with material/optional edits).
    const cg = componentAltGroups.get(group);
    if (cg && cg.members.has(String(pickedId))) {
      const comps = compsOf(cg.lineId);
      for (let i = 0; i < comps.length; i++) {
        if (String(comps[i].alternativeGroup) === group) {
          comps[i] = { ...comps[i], isSelectedAlternative: String(comps[i].id) === String(pickedId) };
        }
      }
      merge(cg.lineId, { components: comps });
    }
  }

  // Optionals — a TOGGLE: on=true folds the add-on into the quote
  // (is_optional=false), on=false takes it back out (is_optional=true). The id
  // is either a LINE the dealer offered (optional_offered) or a COMPONENT the
  // dealer offered (its optionalOffered, one level down). A component toggle
  // flips isOptional on its own entry within the line's working components copy.
  for (const [id, on] of Object.entries(body.optionals || {})) {
    const key = String(id);
    if (optionalIds.has(key)) { merge(key, { is_optional: !on }); continue; }
    if (componentOptionalOffered.has(key) && componentIndex.has(key)) {
      const lineId = componentIndex.get(key)!.lineId;
      const comps = compsOf(lineId);
      const idx = comps.findIndex((c) => String(c.id) === key);
      if (idx >= 0) {
        comps[idx] = { ...comps[idx], isOptional: !on };
        merge(lineId, { components: comps });
      }
    }
  }

  // Materials — re-anchor the line (or component) to the chosen grade.
  for (const [id, gradeRaw] of Object.entries(body.materials || {})) {
    const key = String(id);
    const grade = String(gradeRaw);
    if (!materialGrades.get(key)?.has(grade)) continue;
    if (lineById.has(key)) {
      const p = lineMaterialPatch(lineById.get(key)!, grade, priceMap);
      if (p) merge(key, p);
    } else if (componentIndex.has(key)) {
      const lineId = componentIndex.get(key)!.lineId;
      const comps = compsOf(lineId);
      const idx = comps.findIndex((c) => String(c.id) === key);
      if (idx >= 0) {
        comps[idx] = switchComponentMaterial(comps[idx], grade, priceMap);
        merge(lineId, { components: comps });
      }
    }
  }

  // Free catalog picks — set the line (or component) to ANY fabric the model has
  // a catalog SKU for. Price/cost from the SKU; fabric label + swatch cosmetic.
  // Rejected when the model has no SKU for the grade.
  for (const [id, rawSel] of Object.entries(body.materialPick || {})) {
    const key = String(id);
    const sel = (rawSel || {}) as FreePick;
    if (lineById.has(key)) {
      const p = lineFreeMaterialPatch(lineById.get(key)!, sel, priceMap);
      if (p) merge(key, p);
    } else if (componentIndex.has(key)) {
      const lineId = componentIndex.get(key)!.lineId;
      const comps = compsOf(lineId);
      const idx = comps.findIndex((c) => String(c.id) === key);
      if (idx >= 0) {
        const np = componentFreeMaterialPatch(comps[idx], sel, priceMap);
        if (np) { comps[idx] = np; merge(lineId, { components: comps }); }
      }
    }
  }

  return patches;
}
