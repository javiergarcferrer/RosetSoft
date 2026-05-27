/**
 * Quote-group helpers — per-group attributes (currently `isOptional`) for
 * Conjuntos (sets) and Alternativas, keyed by the same id the member lines
 * carry in `setGroup` / `alternativeGroup`.
 *
 * Semantics of an OPTIONAL group:
 *   • set         → take-all-or-nothing add-on. Materialized as
 *                   `isOptional=true` on every member line, so the existing
 *                   `isPricedLine` excludes them from every total.
 *   • alternative → "pick one OR none". The menu may sit at zero selected,
 *                   which `isPricedLine` already counts as 0.
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

/** How many members of an alternative group are currently selected. */
export function selectedCount(
  lines: readonly QuoteLine[] | null | undefined,
  groupId: string | null | undefined,
): number {
  if (!groupId) return 0;
  return (lines || []).filter((l) => l?.alternativeGroup === groupId && l?.isSelectedAlternative).length;
}

/**
 * Which member id should be the selected one after clicking `clickedId`.
 *
 *   - Mandatory group (allowNone=false): the clicked line becomes the sole
 *     selected one (radio behavior).
 *   - Optional group (allowNone=true): clicking the already-selected line
 *     DESELECTS it → null ("none"); clicking any other selects it.
 *
 * The caller then writes `isSelectedAlternative = (id === result)` across the
 * group's members.
 */
export function desiredSelectedId(
  members: readonly QuoteLine[] | null | undefined,
  clickedId: string,
  allowNone: boolean,
): string | null {
  const clicked = (members || []).find((m) => m.id === clickedId);
  if (allowNone && clicked?.isSelectedAlternative) return null;
  return clickedId;
}
