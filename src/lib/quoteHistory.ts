/**
 * Pure helpers for the quote workspace undo/redo history.
 *
 * The quote builder persists every edit straight to the DB (there's no
 * local draft buffer), so "undo" is implemented as a stack of whole-quote
 * snapshots: before each user action we capture `{ quote, lines }`, and
 * undo restores the previous snapshot by writing it back. These two
 * functions are the only non-trivial, side-effect-free pieces of that
 * machinery, split out here so they can be unit-tested without React or
 * Supabase.
 */

import type { Quote, QuoteLine } from '../types/domain.ts';

export interface QuoteSnapshot {
  quote: Quote;
  lines: QuoteLine[];
}

/**
 * Append `item` to `stack`, keeping at most `limit` most-recent entries
 * (oldest dropped first). Returns a new array — never mutates the input —
 * so it's safe to use with a React ref/state stack.
 */
export function boundedPush<T>(stack: T[], item: T, limit: number): T[] {
  const next = [...stack, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Minimal write set to make the DB's lines for a quote match a snapshot:
 *
 *   - `toDelete` — ids present now but absent in the target (i.e. lines
 *     ADDED since the snapshot; undo removes them).
 *   - `toPut` — every target row. A full upsert is the simplest exact
 *     restore: it rewrites edited fields, re-creates removed rows, and
 *     fixes sort order / group flags in one pass.
 *
 * Pure: takes the current rows (only their ids are read) and the target
 * rows, returns what to delete and what to upsert. The caller performs
 * the actual DB writes.
 */
export function diffLinesForRestore(
  current: Pick<QuoteLine, 'id'>[],
  target: QuoteLine[],
): { toDelete: string[]; toPut: QuoteLine[] } {
  const targetIds = new Set(target.map((l) => l.id));
  const toDelete = current
    .filter((l) => !targetIds.has(l.id))
    .map((l) => l.id);
  return { toDelete, toPut: target };
}
