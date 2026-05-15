import { db } from '../db/database.js';

/**
 * Catalog dedup — one-shot cleanup that collapses duplicate `productVariants`
 * rows that share a `reference` (catalog-wide unique key).
 *
 * The PDF importer (commit 4bcafd0) already prevents new duplicates by
 * collapsing incoming variants against the global catalog, but legacy rows
 * created before that fix still need to be merged.
 *
 * Reference matching is trimmed + case-folded. Reference-less variants
 * (empty / whitespace only) are NEVER touched — multiple empty references
 * are legitimate.
 *
 * Winner-pick rule (in order):
 *   1. Has a non-empty `priceByGrade` map (otherwise the row is a stub)
 *   2. Has an `imageId`
 *   3. Most-recent `updatedAt`
 *   4. Most-recent `createdAt`
 *   5. Stable tiebreak by `id` (lexicographic)
 *
 * Quote lines that point at a loser variant are re-pointed at the winner
 * BEFORE the loser is deleted so existing quotes survive intact. The losers'
 * `productId` is irrelevant once they're gone — quote lines only carry the
 * variant id.
 *
 * Idempotent: running this on already-clean data is a no-op.
 */

function normKey(ref) {
  return (ref || '').trim().toUpperCase();
}

function hasPriceByGrade(v) {
  const p = v.priceByGrade;
  if (!p || typeof p !== 'object') return false;
  return Object.keys(p).length > 0;
}

function toMillis(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Given an array of variants that share a reference, return [winner, ...losers].
 * The winner is selected by the rule documented above.
 */
export function pickWinner(group) {
  const sorted = [...group].sort((a, b) => {
    // 1. priceByGrade non-empty
    const ap = hasPriceByGrade(a) ? 1 : 0;
    const bp = hasPriceByGrade(b) ? 1 : 0;
    if (ap !== bp) return bp - ap;

    // 2. imageId present
    const ai = a.imageId ? 1 : 0;
    const bi = b.imageId ? 1 : 0;
    if (ai !== bi) return bi - ai;

    // 3. Most-recent updatedAt
    const au = toMillis(a.updatedAt);
    const bu = toMillis(b.updatedAt);
    if (au !== bu) return bu - au;

    // 4. Most-recent createdAt
    const ac = toMillis(a.createdAt);
    const bc = toMillis(b.createdAt);
    if (ac !== bc) return bc - ac;

    // 5. Stable tiebreak by id (ascending lex)
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted;
}

/**
 * Quick read-only scan — returns the duplicate groups (referenced-by-multiple)
 * without touching the database. Useful for the confirm dialog count.
 *
 * Returns: { groups: Array<{ key, winner, losers }>, totalDuplicates, totalGroups }
 *   - totalDuplicates: number of LOSER rows that would be deleted
 *   - totalGroups:     number of references that have more than one row
 */
export async function scanDuplicateReferences() {
  const all = await db.productVariants.toArray();
  const byKey = new Map();
  for (const v of all) {
    const k = normKey(v.reference);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(v);
  }
  const groups = [];
  for (const [key, rows] of byKey.entries()) {
    if (rows.length < 2) continue;
    const sorted = pickWinner(rows);
    groups.push({ key, winner: sorted[0], losers: sorted.slice(1) });
  }
  const totalDuplicates = groups.reduce((n, g) => n + g.losers.length, 0);
  return { groups, totalDuplicates, totalGroups: groups.length };
}

/**
 * One-shot dedup. Re-scans the catalog (don't trust a stale scan), re-points
 * any quote_lines that target a loser, then deletes the losers.
 *
 * Returns: {
 *   mergedVariants,   // total loser rows removed
 *   canonicalGroups,  // distinct references that had duplicates
 *   repointedLines,   // quote_lines that were updated to point at a winner
 * }
 */
export async function dedupCatalogReferences() {
  const { groups } = await scanDuplicateReferences();

  if (groups.length === 0) {
    return { mergedVariants: 0, canonicalGroups: 0, repointedLines: 0 };
  }

  // Build a flat map: loserId -> winnerId
  const winnerByLoserId = new Map();
  const allLoserIds = [];
  for (const g of groups) {
    for (const l of g.losers) {
      winnerByLoserId.set(l.id, g.winner.id);
      allLoserIds.push(l.id);
    }
  }

  // Re-point quote_lines. We pull only the lines that reference a loser
  // (one query per loser would be slow on a duplicate-heavy catalog, but a
  // single `where in` would be ideal — the Dexie-shaped wrapper only
  // exposes equals(), so we fetch ALL quote_lines once and filter locally).
  let repointedLines = 0;
  const allLines = await db.quoteLines.toArray();
  for (const line of allLines) {
    if (!line.productVariantId) continue;
    const newId = winnerByLoserId.get(line.productVariantId);
    if (!newId) continue;
    await db.quoteLines.update(line.id, { productVariantId: newId });
    repointedLines++;
  }

  // Delete the losers in one bulk call.
  await db.productVariants.bulkDelete(allLoserIds);

  return {
    mergedVariants: allLoserIds.length,
    canonicalGroups: groups.length,
    repointedLines,
  };
}
