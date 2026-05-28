/**
 * Fold a share-link recipient's picks into the line set the public preview +
 * totals consume. Pure (no React, no fetch) so the public view stays a thin
 * shell and the transform is unit-tested in isolation.
 *
 * Three kinds of pick, applied per line (and per compound component):
 *   - alternatives  the chosen member of an `alternativeGroup` becomes the
 *                   selected one (so only it is priced + reads un-dimmed).
 *   - optionals     an included optional is un-flagged, so it both counts in
 *                   the total and renders as a normal line.
 *   - materials     the line/component is re-quoted in a different material
 *                   GRADE: its unit price shifts by that option's price delta
 *                   (baked into the option by the `quote-share` function, with
 *                   margin already applied), so the line total — and the grand
 *                   total — reflect the choice. The base grade (or an unknown /
 *                   zero-delta grade) leaves the price untouched.
 */

import type {
  QuoteLine,
  ClientSelections,
  MaterialOptions,
} from '../types/domain.ts';

// A material option carrying the runtime price delta the quote-share function
// injects. The stored `MaterialOption` has no `delta` (it's derived, never
// frozen), so we widen it here for the public bundle's enriched shape.
type PricedMaterialOption = MaterialOptions['options'][number] & { delta?: number };

/** Anything that can be re-quoted in an alternative material: a line or a component. */
interface MaterialBearing {
  unitPrice?: number;
  materialOptions?: MaterialOptions | null;
}

/**
 * Shift an entity's unit price by the picked grade's delta. The base grade is a
 * no-op (it IS the quoted price); an unknown grade or a delta-less option (no
 * catalog price resolved) is left untouched so a stale pick can't distort the
 * total.
 */
function applyMaterialPick<T extends MaterialBearing>(
  entity: T,
  grade: string | null | undefined,
): T {
  const mo = entity.materialOptions;
  if (!grade || !mo || !Array.isArray(mo.options)) return entity;
  if (grade === mo.baseGrade) return entity;
  const opt = mo.options.find((o) => o.grade === grade) as PricedMaterialOption | undefined;
  const delta = typeof opt?.delta === 'number' ? opt.delta : 0;
  if (!delta) return entity;
  return { ...entity, unitPrice: (Number(entity.unitPrice) || 0) + delta };
}

export function applyClientSelections(
  lines: readonly QuoteLine[] | null | undefined,
  selections: ClientSelections | null | undefined,
): QuoteLine[] {
  const alts = selections?.alternatives || {};
  const opts = selections?.optionals || {};
  const mats = selections?.materials || {};
  return (lines || []).map((l) => {
    // 1. Material pick on the line itself (a standalone fabric item).
    let line: QuoteLine = applyMaterialPick(l, mats[l.id]);
    // 2. Material picks on compound components (keyed by component id).
    if (Array.isArray(line.components) && line.components.length) {
      let touched = false;
      const components = line.components.map((c) => {
        const next = applyMaterialPick(c, mats[c.id]);
        if (next !== c) touched = true;
        return next;
      });
      if (touched) line = { ...line, components };
    }
    // 3. Alternative selection — the chosen member becomes the selected one.
    if (line.alternativeGroup && alts[line.alternativeGroup] != null) {
      return { ...line, isSelectedAlternative: alts[line.alternativeGroup] === line.id };
    }
    // 4. Optional inclusion — an included optional un-flags so it counts.
    if (line.isOptional) {
      return opts[line.id] ? { ...line, isOptional: false } : line;
    }
    return line;
  });
}
