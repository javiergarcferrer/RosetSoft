/**
 * Quote-group helpers — per-group attributes (currently `isOptional`) for
 * Conjuntos (sets), keyed by the same id the member lines carry in
 * `setGroup`.
 *
 * An OPTIONAL Conjunto is a take-all-or-nothing add-on: marking it optional
 * materializes `isOptional=true` onto every member line, so the existing
 * `isPricedLine` excludes them from every total. (Alternativas are NOT
 * optional — building an alternative means at least one option will be used,
 * so it always counts toward the total.)
 */

import type { QuoteGroup, QuoteLine } from '../types/domain.ts';

export function groupById(
  groups: readonly QuoteGroup[] | null | undefined,
  id: string | null | undefined,
): QuoteGroup | undefined {
  if (!id) return undefined;
  return (groups || []).find((g) => g.id === id);
}

/** Is the group (by id) marked optional? Absent row ⇒ not optional. */
export function isGroupOptional(
  groups: readonly QuoteGroup[] | null | undefined,
  id: string | null | undefined,
): boolean {
  return !!groupById(groups, id)?.isOptional;
}

/* ----------------------- group invariants (pure) ----------------------- */
/*
 * The grouping invariants the quote-builder mutations must maintain, lifted
 * out of the orchestrator so they're one source of truth instead of being
 * re-derived inside removeLine / ungroupLine / separateFromSet / selectAlternative
 * — and so they can be unit-tested. Each returns the PATCHES to apply (the
 * caller does the db writes + any undo capture); none performs I/O.
 */

/** A line patch: the id to update and the partial fields to set. */
export interface LinePatch {
  id: string;
  patch: Partial<Pick<QuoteLine, 'alternativeGroup' | 'isSelectedAlternative' | 'setGroup' | 'isOptional'>>;
}

/**
 * Selecting one option in an Alternativa: exactly ONE sibling carries
 * `isSelectedAlternative`. Returns the minimal patches (only siblings whose
 * flag actually changes) to make `pickedId` the selected one. The DB allows
 * 0 or N selected at rest, but isPricedLine would then count the wrong number
 * of lines — this writer enforces the invariant.
 */
export function selectAlternativePatches(
  siblings: readonly Pick<QuoteLine, 'id' | 'isSelectedAlternative'>[],
  pickedId: string,
): LinePatch[] {
  const patches: LinePatch[] = [];
  for (const s of siblings || []) {
    const shouldBeSelected = s.id === pickedId;
    if (!!s.isSelectedAlternative !== shouldBeSelected) {
      patches.push({ id: s.id, patch: { isSelectedAlternative: shouldBeSelected } });
    }
  }
  return patches;
}

/**
 * Heal an ALTERNATIVA after `removed` leaves it (deleted or ungrouped). The
 * invariant: a group is either ≥2 members with exactly one selected, or it
 * doesn't exist. Given the SURVIVING siblings (members minus the removed line)
 * and whether the removed line was the selected one:
 *   • 1 survivor   → promote it to standalone (clear group + selection) — a
 *                    "menu of one" is meaningless.
 *   • >1 survivors and the removed line was selected → select the first
 *                    survivor so exactly one line stays priced.
 *   • otherwise    → nothing to heal.
 * Returns the patch(es) to apply (at most one).
 */
export function healAlternativeOnRemove(
  survivors: readonly Pick<QuoteLine, 'id'>[],
  removedWasSelected: boolean,
): LinePatch[] {
  const list = survivors || [];
  if (list.length === 1) {
    return [{ id: list[0].id, patch: { alternativeGroup: null, isSelectedAlternative: false } }];
  }
  if (list.length > 1 && removedWasSelected) {
    return [{ id: list[0].id, patch: { isSelectedAlternative: true } }];
  }
  return [];
}

/**
 * Heal a CONJUNTO (set) after a member leaves: a set of one is meaningless, so
 * a lone survivor is promoted to standalone (clearing the optional state that
 * belonged to the group) and the group row should be deleted. Given the
 * surviving members, returns the line patch(es) plus whether to delete the
 * group row.
 */
export function healSetOnRemove(
  survivors: readonly Pick<QuoteLine, 'id'>[],
): { linePatches: LinePatch[]; deleteGroup: boolean } {
  const list = survivors || [];
  if (list.length === 1) {
    return {
      linePatches: [{ id: list[0].id, patch: { setGroup: null, isOptional: false } }],
      deleteGroup: true,
    };
  }
  return { linePatches: [], deleteGroup: false };
}
