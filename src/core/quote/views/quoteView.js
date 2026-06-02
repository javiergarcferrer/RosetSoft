// resolveQuoteView — THE shared content ViewModel for a quote.
//
// MVVM: the client preview (the editor "Vista cliente" pane + the public link,
// both `ClientPreview`) AND the PDF generator render THIS one tree. It resolves
// the CONTENT — the rate, the totals + ranges, the savings, the section →
// group-run structure with each run's footer DATA, and the "N de M" position
// maps — but never presentation: footer values are numbers/ranges and footer
// kinds are semantic (`set` / `alternative`), so each renderer formats + labels
// + lays out for its medium (HTML vs pdf-lib). One tree ⇒ screen and paper can
// never show different content.
import {
  computeTotals, computeTotalsRange, lineForTotals, quoteSavings,
  groupBySection, groupRuns, sectionSubtotal,
  setSubtotal, setSubtotalRange, alternativeSubtotal, selectedAlternative,
  lineHasRange, lineTotalRange, alternativeGroupInfo, setGroupInfo,
} from '../../../lib/pricing.js';
import { isPricedLine } from '../../../lib/constants.js';
import { isGroupOptional } from '../../../lib/quoteGroups.js';
import { quoteRateState } from '../../../lib/exchangeRate.js';

// Footer DATA for a group run (set / alternative) — numbers, not strings. The
// renderer turns `kind` into its label ("Total del conjunto" / "TOTAL") and
// formats `amount` / `amountRange` in the quote's currency.
function runFooter(lines, run, quoteGroups) {
  if (run.type === 'set') {
    const sr = setSubtotalRange(lines, run.groupId);
    return {
      kind: 'set',
      amount: setSubtotal(lines, run.groupId),
      amountRange: sr.max > sr.min ? sr : null,
      optional: isGroupOptional(quoteGroups, run.groupId),
    };
  }
  // Alternative: only the SELECTED option is billed; lineHasRange (not
  // isRangeLine) so a compound selected alternative rolls up as a range too.
  const sel = selectedAlternative(lines, run.groupId);
  return {
    kind: 'alternative',
    amount: alternativeSubtotal(lines, run.groupId),
    amountRange: sel && lineHasRange(sel) ? lineTotalRange(sel) : null,
    optional: false,
  };
}

export function resolveQuoteView({ quote, lines, settings, quoteGroups }) {
  const ls = Array.isArray(lines) ? lines : [];
  const q = quote || {};

  const totals = computeTotals(ls.filter(isPricedLine).map(lineForTotals), q);
  const totalsRange = computeTotalsRange(ls, {
    marginPct: q.marginPct, discountPct: q.discountPct,
    courtesyDiscountPct: q.courtesyDiscountPct, shipping: q.shipping,
  });

  // Section → group-run structure (the card boundaries), resolved once. Each
  // run carries its member line ids + (for set/alternative) its footer data.
  const sections = groupBySection(ls).map((g) => ({
    label: g.label,
    items: g.items,
    subtotal: g.label ? sectionSubtotal(g.items) : 0,
    runs: groupRuns(g.items).map((run) => ({
      type: run.type,            // 'single' | 'set' | 'alternative'
      groupId: run.groupId,
      lineIds: run.lineIds,
      start: run.start,
      footer: run.type === 'single' ? null : runFooter(ls, run, quoteGroups),
    })),
  }));

  return {
    rate: quoteRateState(q, settings),
    totals,
    totalsRange,
    hasRange: totalsRange.max > totalsRange.min,
    savings: quoteSavings(ls, totals),
    // "Alternativa / Conjunto N de M" position lookups, keyed by line id.
    groupInfo: alternativeGroupInfo(ls),
    setInfo: setGroupInfo(ls),
    sections,
  };
}
