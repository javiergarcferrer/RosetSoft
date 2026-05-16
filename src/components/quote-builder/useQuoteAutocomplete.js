import { useMemo } from 'react';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';

/**
 * The "catalog substitute": derive a deduped list of past line items from
 * every quote in the team, so when the dealer types a reference or name in
 * the new line, recent matches surface in the command palette and as inline
 * suggestions. The list gets richer the more the team uses the app.
 *
 * Returned shape: array of suggestions, each
 *   { key, family, reference, name, subtype, dimensions, yardage, pageRef,
 *     unitPrice, description, imageId, lastUsedAt, useCount }
 * where `key = reference || name + family` so duplicates merge.
 */
export function useQuoteAutocomplete() {
  // Pull every line. Cheap for the data sizes this app targets (a few
  // thousand at most) and the Dashboard already does the same fetch, so it
  // hits the same cache.
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);

  const suggestions = useMemo(() => {
    const byKey = new Map();
    for (const l of allLines) {
      if (l.kind === 'section') continue;
      // Need at least *something* identifying to be a useful suggestion.
      const ident = (l.reference || '').trim() || (l.name || '').trim();
      if (!ident) continue;
      const key = ((l.reference || '').trim().toUpperCase() || `${l.family || ''}::${l.name || ''}`);
      const prev = byKey.get(key);
      const cand = {
        key,
        family: l.family || '',
        reference: l.reference || '',
        name: l.name || '',
        subtype: l.subtype || '',
        dimensions: l.dimensions || '',
        yardage: l.yardage || '',
        pageRef: l.pageRef || '',
        unitPrice: Number(l.unitPrice) || 0,
        description: l.description || '',
        imageId: l.imageId || null,
        lastUsedAt: 0,
        useCount: 0,
      };
      if (!prev) {
        byKey.set(key, { ...cand, useCount: 1 });
      } else {
        // Keep the richest record (most filled-in fields), bump count.
        const merged = mergeRicher(prev, cand);
        merged.useCount = (prev.useCount || 0) + 1;
        byKey.set(key, merged);
      }
    }
    return [...byKey.values()].sort((a, b) => b.useCount - a.useCount);
  }, [allLines]);

  /**
   * Filter suggestions by a query string. Matches across reference / name /
   * family / subtype (all case-insensitive). Returns at most `limit`.
   */
  function search(query, limit = 12) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return suggestions.slice(0, limit);
    return suggestions
      .filter((s) => (
        s.reference.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.family.toLowerCase().includes(q) ||
        s.subtype.toLowerCase().includes(q)
      ))
      .slice(0, limit);
  }

  return { suggestions, search };
}

function mergeRicher(a, b) {
  const out = { ...a };
  for (const k of ['family', 'reference', 'name', 'subtype', 'dimensions', 'yardage', 'pageRef', 'description']) {
    if (!out[k] && b[k]) out[k] = b[k];
  }
  if (!out.imageId && b.imageId) out.imageId = b.imageId;
  // Prefer the most recent non-zero unit price as the seed.
  if (!out.unitPrice && b.unitPrice) out.unitPrice = b.unitPrice;
  return out;
}
