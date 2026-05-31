// Quote Model — the canonical MUTATION reducer for a quote bundle.
//
// MVVM: this is the Model's single "apply an action" function. Both the
// optimistic client path (PublicQuoteView, via lib/clientPick re-export) and
// the authoritative server path (the quote-share Edge Function mirrors the same
// semantics) resolve a pick the same way, so a recipient's choice can never be
// applied two different ways. Pure: it takes a bundle + an action and returns a
// NEW bundle (or the same reference if nothing changed) — no I/O, no React.
//
// Action shape (matches the share API):
//   - alternatives: { [group]: id }      only the chosen member stays selected
//                                         (a LINE group, or a COMPONENT group
//                                         one level down inside a compound).
//   - optionals:    { [id]: boolean }    a toggle — `on` folds the add-on in
//                                         (isOptional = !on); only entities the
//                                         dealer OFFERED (optionalOffered) flip.
//   - materials:    { [id]: grade }      re-anchor a line/component to a grade,
//                                         recompose subtype + reference + swatch,
//                                         reprice, and drop any price range.
//   - materialPick: { [id]: { grade, fabric, swatchImageId } }
//                                         the FULL catalog picker — set a
//                                         line/component to ANY fabric the model
//                                         offers (not just the dealer's
//                                         alternatives), repricing by grade. An
//                                         EMPTY grade clears the fabric instead,
//                                         restoring the model's price range
//                                         (the "sin material" state).
//
// The client lacks the catalog price map; it doesn't need it — for `materials`
// the bundle carries each option's per-unit `delta` (margin-applied), so
// `newUnitPrice = unitPrice + delta` reproduces the server's repriced unit; for
// `materialPick` the bundle carries each line's per-grade `gradePrices` (also
// margin-applied), so the new unit is `gradePrices[grade]`.
import { composeSubtype } from '../../lib/subtype.js';
import { splitSkuGrade } from '../../lib/catalog.js';

/** Grades a target offers = its base grade + every option grade. */
function offeredGrades(mo) {
  const set = new Set();
  if (!mo || !Array.isArray(mo.options) || !mo.options.length) return set;
  if (mo.baseGrade != null) set.add(String(mo.baseGrade));
  for (const o of mo.options) if (o?.grade != null) set.add(String(o.grade));
  return set;
}

/**
 * Re-anchor a materialOptions blob so `pickedGrade` becomes the base. Mirrors
 * the Edge Function's reanchor(), and additionally re-bases the baked per-option
 * `delta`s (server recomputes them from the catalog; we do it by arithmetic so
 * the strip is correct in the optimistic frame too). Returns null for an
 * invalid pick (grade not offered).
 *
 * `delta` is the picked option's per-unit price change vs the current base —
 * the caller adds it to the unit price.
 */
export function reanchorMaterial(mo, pickedGrade, currentSwatchId) {
  if (!mo) return null;
  const options = Array.isArray(mo.options) ? mo.options : [];
  const picked = String(pickedGrade);
  if (String(mo.baseGrade) === picked) {
    return { newMo: mo, label: String(mo.baseLabel ?? ''), newSwatchId: currentSwatchId ?? null, delta: 0 };
  }
  const pickedOpt = options.find((o) => String(o.grade) === picked);
  if (!pickedOpt) return null;
  const pickedDelta = typeof pickedOpt.delta === 'number' ? pickedOpt.delta : null;
  const rebase = (o) => {
    const { delta, ...rest } = o;
    if (typeof delta === 'number' && pickedDelta != null) return { ...rest, delta: delta - pickedDelta };
    return rest; // drop a non-numeric delta rather than carry a stale one
  };
  // The old base is demoted to an option carrying the entity's CURRENT swatch,
  // so switching back later keeps it.
  const oldBase = { grade: mo.baseGrade, label: mo.baseLabel ?? '', code: null, swatchImageId: currentSwatchId ?? null };
  if (pickedDelta != null) oldBase.delta = -pickedDelta;
  const newOptions = options.filter((o) => String(o.grade) !== picked).map(rebase).concat([oldBase]);
  return {
    newMo: { baseGrade: pickedOpt.grade, baseLabel: pickedOpt.label ?? '', options: newOptions },
    label: String(pickedOpt.label ?? ''),
    newSwatchId: pickedOpt.swatchImageId ?? null,
    delta: pickedDelta,
  };
}

/** Return a NEW line/component with its material switched to `grade`. */
function switchMaterial(entity, grade) {
  const r = reanchorMaterial(entity.materialOptions, grade, entity.swatchImageId);
  if (!r) return entity; // invalid grade → leave untouched (mirrors the server)
  const root = splitSkuGrade(entity.reference || '').root;
  const next = {
    ...entity,
    materialOptions: r.newMo,
    swatchImageId: r.newSwatchId,
    subtype: composeSubtype(grade, r.label),
    // Picking a material resolves a material-less RANGE — drop it (the price is
    // now pinned), mirroring the server (quote-share) and the editor.
    priceMin: null,
    priceMax: null,
  };
  if (root) next.reference = root + String(grade).toUpperCase();
  // Reprice only when a numeric delta is available — same graceful skip the
  // server makes when the catalog has no price for the grade.
  if (typeof r.delta === 'number') next.unitPrice = (Number(entity.unitPrice) || 0) + r.delta;
  return next;
}

/**
 * Remove the chosen fabric, returning the line/component to its material-less
 * RANGE — the model's cheapest→priciest grade price (priceMin..priceMax), the
 * exact shape a "sin material" line is added in. Mirrors the server's clear
 * branch (quote-share/pick.ts `clearLineMaterial`/`clearComponentMaterial`).
 * Reads the per-grade `gradePrices` the bundle already carries; a no-op when the
 * model can't form a range (fewer than two distinct grade prices) — there's
 * nothing to revert to. The reference is left as-is: it still resolves the
 * family root for a later re-pick, and the range (not the reference) prices it.
 */
function clearMaterial(entity) {
  const vals = entity.gradePrices
    ? Object.values(entity.gradePrices).map(Number).filter((n) => Number.isFinite(n))
    : [];
  if (vals.length < 2) return entity;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (!(max > min)) return entity;
  return { ...entity, subtype: '', swatchImageId: null, unitPrice: min, priceMin: min, priceMax: max };
}

/**
 * Set a line/component to an ARBITRARY catalog fabric (the full picker). Reprices
 * from the bundle's per-grade `gradePrices` (margin already baked); the fabric
 * label + swatch are cosmetic. Returns the same reference for an invalid grade
 * (no SKU/price), mirroring the server's lineFreeMaterialPatch reject. When the
 * entity carried dealer alternatives we only re-base them — the bundle's deltas
 * already read relative to the live base.
 */
function applyFreeMaterial(entity, sel) {
  const grade = String(sel?.grade ?? '').trim();
  // An empty grade is the recipient CLEARING their fabric — drop it and return
  // the line/component to the model's price range (the "sin material" state).
  if (!grade) return clearMaterial(entity);
  const price = entity.gradePrices ? entity.gradePrices[grade.toUpperCase()] : undefined;
  if (typeof price !== 'number') return entity; // grade has no catalog SKU → reject
  const fabric = String(sel?.fabric ?? '').slice(0, 200);
  const root = splitSkuGrade(entity.reference || '').root;
  const next = {
    ...entity,
    subtype: composeSubtype(grade, fabric),
    swatchImageId: sel?.swatchImageId == null ? null : sel.swatchImageId,
    unitPrice: price,
    priceMin: null,
    priceMax: null,
  };
  if (root) next.reference = root + grade.toUpperCase();
  const mo = entity.materialOptions;
  if (mo && Array.isArray(mo.options) && mo.options.length) {
    next.materialOptions = { ...mo, baseGrade: grade.toUpperCase(), baseLabel: fabric };
  }
  return next;
}

/**
 * Apply ONE recipient action to a quote bundle, returning a NEW bundle (or the
 * same reference if nothing changed). Pure; only `lines` (and components within
 * them) are touched. See the file header for the action shape.
 */
export function applyAction(bundle, pick) {
  if (!bundle || !pick) return bundle;
  const lines = Array.isArray(bundle.lines) ? bundle.lines : [];
  const next = lines.slice(); // replace only touched entries
  let changed = false;

  // Alternatives — only the chosen member of a group stays selected. The group
  // is EITHER a line alternative group OR a component alternative group inside a
  // compound; component ids are globally unique, so one channel serves both.
  for (const [group, pickedId] of Object.entries(pick.alternatives || {})) {
    // Line-level group.
    const memberIdxs = [];
    for (let i = 0; i < next.length; i++) if (next[i].alternativeGroup === group) memberIdxs.push(i);
    if (memberIdxs.length > 0) {
      if (!memberIdxs.some((i) => next[i].id === pickedId)) continue; // invalid member
      for (const i of memberIdxs) {
        const sel = next[i].id === pickedId;
        if (!!next[i].isSelectedAlternative !== sel) { next[i] = { ...next[i], isSelectedAlternative: sel }; changed = true; }
      }
      continue;
    }
    // Component-level group inside a compound line.
    for (let i = 0; i < next.length; i++) {
      const comps = next[i].components;
      if (!Array.isArray(comps)) continue;
      const members = comps.filter((c) => c.alternativeGroup === group);
      if (members.length === 0) continue;
      if (members.some((c) => c.id === pickedId)) {
        next[i] = {
          ...next[i],
          components: comps.map((c) =>
            c.alternativeGroup === group ? { ...c, isSelectedAlternative: c.id === pickedId } : c,
          ),
        };
        changed = true;
      }
      break;
    }
  }

  // Optionals — a TOGGLE: `on` includes the add-on (isOptional = !on), and it
  // flips back out when `on` is false. Eligible = lines (or components one
  // level down) the dealer OFFERED as optional (optionalOffered), NOT just the
  // currently-excluded ones, so an already-included optional can be toggled off
  // again — mirrors the server.
  for (const [id, on] of Object.entries(pick.optionals || {})) {
    // Line-level offered optional (a standalone dealer add-on).
    const li = next.findIndex((l) => l.id === id);
    if (li >= 0) {
      if (!next[li].optionalOffered || !!next[li].isOptional === !on) continue;
      next[li] = { ...next[li], isOptional: !on };
      changed = true;
      continue;
    }
    // Component-level offered optional inside a compound line.
    for (let i = 0; i < next.length; i++) {
      const comps = next[i].components;
      if (!Array.isArray(comps)) continue;
      const ci = comps.findIndex((c) => c.id === id && c.optionalOffered);
      if (ci < 0) continue;
      if (!!comps[ci].isOptional !== !on) {
        const newComps = comps.slice();
        newComps[ci] = { ...newComps[ci], isOptional: !on };
        next[i] = { ...next[i], components: newComps };
        changed = true;
      }
      break;
    }
  }

  // Materials — the id is a line OR a component within a compound line.
  for (const [id, grade] of Object.entries(pick.materials || {})) {
    const li = next.findIndex((l) => l.id === id && l.materialOptions?.options?.length);
    if (li >= 0) {
      if (!offeredGrades(next[li].materialOptions).has(String(grade))) continue;
      const switched = switchMaterial(next[li], grade);
      if (switched !== next[li]) { next[li] = switched; changed = true; }
      continue;
    }
    for (let i = 0; i < next.length; i++) {
      const comps = next[i].components;
      if (!Array.isArray(comps)) continue;
      const ci = comps.findIndex((c) => c.id === id && c.materialOptions?.options?.length);
      if (ci < 0) continue;
      if (offeredGrades(comps[ci].materialOptions).has(String(grade))) {
        const newComps = comps.slice();
        newComps[ci] = switchMaterial(comps[ci], grade);
        next[i] = { ...next[i], components: newComps };
        changed = true;
      }
      break;
    }
  }

  // Full catalog picker — set a line/component to ANY fabric the model offers.
  // The id is a line OR a component within a compound line.
  for (const [id, sel] of Object.entries(pick.materialPick || {})) {
    const li = next.findIndex((l) => l.id === id);
    if (li >= 0) {
      const applied = applyFreeMaterial(next[li], sel);
      if (applied !== next[li]) { next[li] = applied; changed = true; }
      continue;
    }
    for (let i = 0; i < next.length; i++) {
      const comps = next[i].components;
      if (!Array.isArray(comps)) continue;
      const ci = comps.findIndex((c) => c.id === id);
      if (ci < 0) continue;
      const applied = applyFreeMaterial(comps[ci], sel);
      if (applied !== comps[ci]) {
        const newComps = comps.slice();
        newComps[ci] = applied;
        next[i] = { ...next[i], components: newComps };
        changed = true;
      }
      break;
    }
  }

  return changed ? { ...bundle, lines: next } : bundle;
}

// Back-compat alias: the optimistic client path imports `applyClientPick`.
export { applyAction as applyClientPick };
