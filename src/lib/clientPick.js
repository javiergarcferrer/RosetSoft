// Optimistic, client-side application of a public-quote pick.
//
// The public quote view (PublicQuoteView) persists each pick through the
// `quote-share` Edge Function, which is the source of truth. But waiting for
// that round-trip before the preview moves feels laggy. This module replays the
// SAME mutation locally so the preview + total update instantly; the server
// response is then swapped in to reconcile.
//
// It mirrors the function's pick semantics exactly (see
// supabase/functions/quote-share/index.ts):
//   - alternatives: only the chosen group member stays selected.
//   - optionals:    a toggle — `on` folds the add-on into the quote
//                   (isOptional = !on) and `off` takes it back out; only lines
//                   (or COMPONENTS one level down) the dealer OFFERED as
//                   optional (optionalOffered) toggle.
//   - materials:    re-anchor the line/component to the chosen grade, recompose
//                   subtype + reference + swatch, and reprice.
//
// The one thing the client lacks is the catalog price map. It doesn't need it:
// the bundle already carries each option's per-unit `delta` (margin-applied),
// so `newUnitPrice = unitPrice + delta` reproduces the server's repriced unit
// exactly, and the remaining option deltas re-base by arithmetic.
import { composeSubtype } from './subtype.js';
import { splitSkuGrade } from './catalog.js';

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
function reanchorMaterial(mo, pickedGrade, currentSwatchId) {
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
  };
  if (root) next.reference = root + String(grade).toUpperCase();
  // Reprice only when a numeric delta is available — same graceful skip the
  // server makes when the catalog has no price for the grade.
  if (typeof r.delta === 'number') next.unitPrice = (Number(entity.unitPrice) || 0) + r.delta;
  return next;
}

/**
 * Apply ONE recipient pick to a client bundle, returning a NEW bundle (or the
 * same reference if nothing changed). Pure; only `lines` (and components within
 * them) are touched. `pick` matches the share API:
 *   { alternatives: { [group]: lineId } }
 *   { optionals:    { [lineId]: boolean } }
 *   { materials:    { [lineOrComponentId]: grade } }
 */
export function applyClientPick(bundle, pick) {
  if (!bundle || !pick) return bundle;
  const lines = Array.isArray(bundle.lines) ? bundle.lines : [];
  const next = lines.slice(); // replace only touched entries
  let changed = false;

  // Alternatives — only the chosen member of a group stays selected.
  for (const [group, lineId] of Object.entries(pick.alternatives || {})) {
    const memberIdxs = [];
    for (let i = 0; i < next.length; i++) if (next[i].alternativeGroup === group) memberIdxs.push(i);
    if (!memberIdxs.some((i) => next[i].id === lineId)) continue; // invalid group / member
    for (const i of memberIdxs) {
      const sel = next[i].id === lineId;
      if (!!next[i].isSelectedAlternative !== sel) { next[i] = { ...next[i], isSelectedAlternative: sel }; changed = true; }
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

  return changed ? { ...bundle, lines: next } : bundle;
}
