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

import type { QuoteGroup } from '../types/domain.ts';

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
