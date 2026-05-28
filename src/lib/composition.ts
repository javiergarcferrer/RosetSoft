/**
 * Composition parsing — fabrics store their fiber make-up as one free-text
 * field (e.g. "COTTON 80%, POLYESTER 20%"). The catalog picker needs a little
 * structure on top of that string to sort and group by the dominant fiber
 * WITHOUT a schema change: parse the text into fiber/percent parts and derive
 * a primary fiber (the highest-percentage one, or the first listed when no
 * percentages are given).
 *
 * Heuristic, not a spec parser — the goal is good buckets for grouping, so it
 * tolerates either order ("80% COTTON" or "COTTON 80%"), several separators
 * (comma, semicolon, slash, "+", "and"/"y"), and multi-word fibers
 * ("VIRGIN WOOL").
 */

export interface FiberPart {
  /** Title-cased fiber name, e.g. "Cotton", "Virgin Wool". */
  fiber: string;
  /** Percentage when present in the text, else null. */
  pct: number | null;
}

/** Bucket label for materials with no usable composition text. */
export const NO_COMPOSITION = 'Sin composición';

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[\p{L}]/gu, (c) => c.toUpperCase());
}

/**
 * Break a composition string into its fiber/percent parts, in listed order.
 * Returns [] for empty/blank/unparseable input.
 */
export function parseComposition(text: string | null | undefined): FiberPart[] {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/\s*(?:[,;/+]|\band\b|\by\b)\s*/i)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const m = seg.match(/(\d+(?:[.,]\d+)?)\s*%?/);
      const pct = m ? Number(m[1].replace(',', '.')) : null;
      const fiber = titleCase(
        seg.replace(/\d+(?:[.,]\d+)?\s*%?/g, ' ').replace(/\s+/g, ' ').trim(),
      );
      return { fiber, pct: pct != null && Number.isFinite(pct) ? pct : null };
    })
    .filter((p) => p.fiber);
}

/**
 * The dominant fiber of a composition: the highest-percentage part, or the
 * first listed part when no percentages are present. Empty string when the
 * text yields nothing usable (callers bucket these under NO_COMPOSITION).
 */
export function primaryFiber(text: string | null | undefined): string {
  const parts = parseComposition(text);
  if (!parts.length) return '';
  const withPct = parts.filter((p) => p.pct != null);
  if (withPct.length) {
    return withPct.reduce((best, p) => ((p.pct as number) > (best.pct as number) ? p : best)).fiber;
  }
  return parts[0].fiber;
}

/**
 * Grouping key (and header label) for a material's composition — its primary
 * fiber, or the NO_COMPOSITION bucket when the text is blank/unparseable.
 */
export function compositionGroup(text: string | null | undefined): string {
  return primaryFiber(text) || NO_COMPOSITION;
}
