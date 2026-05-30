// ViewModel for the client-facing quote preview.
//
// MVVM: the View (components/quote-builder/ClientPreview.jsx — rendered both as
// the in-editor "Vista cliente" pane AND the public share link) renders THIS;
// it derives nothing itself. Pure: it assembles the presentation facts the
// preview needs — section grouping, the savings callout, the grand-total range,
// and the alternative/set position lookups — from the quote Model's pricing
// helpers. Changing what the preview shows is a change here, in one place, not
// scattered through the renderer.
import {
  quoteSavings, computeTotalsRange, alternativeGroupInfo, setGroupInfo,
} from '../../../lib/pricing.js';
import { LINE_KIND_SECTION } from '../../../lib/constants.js';

// Group lines under their preceding section, if any. Top-level items (no
// section before them) live under a null-key group rendered without a heading.
function groupBySection(lines) {
  const groups = [];
  let cur = { label: null, items: [] };
  for (const l of lines) {
    if (l.kind === LINE_KIND_SECTION) {
      if (cur.items.length || cur.label) groups.push(cur);
      cur = { label: l.name || 'Sección', items: [] };
    } else {
      cur.items.push(l);
    }
  }
  if (cur.items.length || cur.label) groups.push(cur);
  return groups;
}

/**
 * Resolve the client-preview ViewModel.
 *
 * @param {object}  input
 * @param {object}  input.quote   the quote (for margin / discount / shipping)
 * @param {Array}   input.lines   the quote lines
 * @param {object}  input.totals  the scalar totals already computed for the view
 * @returns {{ groups, savings, totalsRange, hasRange, groupInfo, setInfo }}
 */
export function resolveClientPreview({ quote, lines, totals }) {
  const ls = Array.isArray(lines) ? lines : [];
  // Grand-total RANGE — derived from the lines (not the `totals` prop) so the
  // public link, which has no catalog, still widens for material-less pieces.
  const totalsRange = computeTotalsRange(ls, {
    marginPct: quote?.marginPct,
    discountPct: quote?.discountPct,
    shipping: quote?.shipping,
  });
  return {
    groups: groupBySection(ls),
    savings: quoteSavings(ls, totals),
    totalsRange,
    hasRange: totalsRange.max > totalsRange.min,
    // "Alternativa N de M" / "Conjunto N de M" position lookups, keyed by line id.
    groupInfo: alternativeGroupInfo(ls),
    setInfo: setGroupInfo(ls),
  };
}
