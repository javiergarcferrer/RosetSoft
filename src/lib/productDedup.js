import { db } from '../db/database.js';
import { dedupCatalogReferences } from './catalogDedup.js';

/**
 * Product-level dedup — collapses duplicate `products` rows that share the
 * same (name, designer) pair after trimming + case-folding. Variants are
 * re-pointed onto the winning product, then the variant ref-level dedup is
 * re-run because the merge can produce duplicate references across what
 * were previously two distinct products.
 *
 * Year is intentionally NOT part of the group key — the same designer can
 * reissue a model with a different year, but those should still merge into
 * one catalog row (the user's complaint: two "ABANDON" rows with the same
 * designer + year).
 *
 * Winner-pick rule (in order):
 *   1. Has BOTH heroImageId AND vectorImageId
 *   2. Has heroImageId OR vectorImageId
 *   3. Has a non-empty description
 *   4. Most-recent updatedAt
 *   5. Most-recent createdAt
 *   6. Stable tiebreak by id (lexicographic)
 *
 * After picking the winner, any empty winner field that the loser had
 * populated is filled in — so we don't lose a description / hero image
 * just because the row with the better image had an empty description.
 *
 * Idempotent: running this on a clean catalog is a no-op.
 */

function normKey(s) {
  return (s || '').trim().toLowerCase();
}

function toMillis(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

function hasBothImages(p) {
  return !!p.heroImageId && !!p.vectorImageId;
}
function hasAnyImage(p) {
  return !!p.heroImageId || !!p.vectorImageId;
}
function hasDescription(p) {
  return !!(p.description && String(p.description).trim());
}

export function pickProductWinner(group) {
  const sorted = [...group].sort((a, b) => {
    // 1. Both images
    const ab = hasBothImages(a) ? 1 : 0;
    const bb = hasBothImages(b) ? 1 : 0;
    if (ab !== bb) return bb - ab;

    // 2. Any image
    const ai = hasAnyImage(a) ? 1 : 0;
    const bi = hasAnyImage(b) ? 1 : 0;
    if (ai !== bi) return bi - ai;

    // 3. Description
    const ad = hasDescription(a) ? 1 : 0;
    const bd = hasDescription(b) ? 1 : 0;
    if (ad !== bd) return bd - ad;

    // 4. Most-recent updatedAt
    const au = toMillis(a.updatedAt);
    const bu = toMillis(b.updatedAt);
    if (au !== bu) return bu - au;

    // 5. Most-recent createdAt
    const ac = toMillis(a.createdAt);
    const bc = toMillis(b.createdAt);
    if (ac !== bc) return bc - ac;

    // 6. Stable tiebreak by id
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted;
}

/**
 * Read-only scan — returns the duplicate (name, designer) groups.
 * Returns: { groups, totalDuplicates, totalGroups }
 *   - totalDuplicates: number of LOSER product rows that would be deleted
 *   - totalGroups: number of distinct (name, designer) pairs that have
 *     more than one product row
 */
export async function scanDuplicateProducts() {
  const all = await db.products.toArray();
  const byKey = new Map();
  for (const p of all) {
    const k = normKey(p.name) + '||' + normKey(p.designer);
    if (!normKey(p.name)) continue; // ignore name-less rows
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }
  const groups = [];
  for (const [key, rows] of byKey.entries()) {
    if (rows.length < 2) continue;
    const sorted = pickProductWinner(rows);
    groups.push({ key, winner: sorted[0], losers: sorted.slice(1) });
  }
  const totalDuplicates = groups.reduce((n, g) => n + g.losers.length, 0);
  return { groups, totalDuplicates, totalGroups: groups.length };
}

/**
 * Build a "fill empty fields on the winner from the loser" patch. Only
 * fields that are empty on the winner but populated on the loser are
 * included. Fields not in the explicit list are left alone — we don't want
 * to splat arbitrary loser state onto the winner.
 */
function buildFillPatch(winner, loser) {
  const fields = [
    'heroImageId',
    'vectorImageId',
    'description',
    'designer',
    'year',
    'modelCode',
    'categoryId',
  ];
  const patch = {};
  for (const f of fields) {
    const w = winner[f];
    const l = loser[f];
    const winnerEmpty = w == null || w === '' || (typeof w === 'string' && !w.trim());
    const loserHas = l != null && l !== '' && !(typeof l === 'string' && !l.trim());
    if (winnerEmpty && loserHas) patch[f] = l;
  }
  return patch;
}

/**
 * One-shot dedup. Re-scans products (don't trust a stale scan), merges
 * each duplicate group, then runs the existing variant ref-level dedup to
 * collapse references that the merge brought together.
 *
 * Returns: {
 *   mergedProducts,        // total loser product rows removed
 *   canonicalProducts,     // distinct (name, designer) groups merged
 *   mergedVariants,        // from the post-merge variant dedup
 *   canonicalRefGroups,    // from the post-merge variant dedup
 *   repointedLines,        // from the post-merge variant dedup
 * }
 */
export async function dedupProductsByName() {
  const { groups } = await scanDuplicateProducts();

  let mergedProducts = 0;
  const canonicalProducts = groups.length;

  for (const g of groups) {
    const { winner, losers } = g;

    // Re-point every variant on each loser to the winner.
    const allVariants = await db.productVariants.toArray();
    const loserIds = new Set(losers.map((l) => l.id));
    const variantsToRepoint = allVariants.filter((v) => loserIds.has(v.productId));
    for (const v of variantsToRepoint) {
      await db.productVariants.update(v.id, { productId: winner.id });
    }

    // Fill in any empty winner fields from the losers (winner has priority,
    // then losers in winner-rank order).
    let accumulated = { ...winner };
    for (const loser of losers) {
      const patch = buildFillPatch(accumulated, loser);
      if (Object.keys(patch).length > 0) {
        accumulated = { ...accumulated, ...patch };
      }
    }
    // Persist the (possibly enriched) winner.
    await db.products.put(accumulated);

    // Delete each loser.
    for (const loser of losers) {
      await db.products.delete(loser.id);
      mergedProducts++;
    }
  }

  // After ALL product merges, sweep the variant table for duplicate refs
  // that the merge produced (each loser may have had a variant with the
  // same reference as the winner).
  const variantResult = await dedupCatalogReferences();

  return {
    mergedProducts,
    canonicalProducts,
    mergedVariants: variantResult.mergedVariants,
    canonicalRefGroups: variantResult.canonicalGroups,
    repointedLines: variantResult.repointedLines,
  };
}
