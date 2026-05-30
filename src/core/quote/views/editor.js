// ViewModel for the editor's line list (the quote-builder compose pane).
//
// MVVM: components/quote-builder/LineItemList.jsx renders THIS — it derives
// nothing itself. Pure projection off the quote Model: the "Alternativa /
// Conjunto N de M" position maps and the per-section subtotals, computed with
// the same shared helpers the client preview and the PDF use, so all three
// surfaces show identical captions and section totals.
import { alternativeGroupInfo, setGroupInfo, sectionSubtotal } from '../../../lib/pricing.js';
import { LINE_KIND_SECTION } from '../../../lib/constants.js';

export function resolveLineList({ lines }) {
  const ls = Array.isArray(lines) ? lines : [];
  // Per-section roll-up — the sum of the priced items between each section
  // header and the next, keyed by the section line's id.
  const sectionSubtotals = new Map();
  let curId = null;
  let acc = [];
  for (const l of ls) {
    if (l.kind === LINE_KIND_SECTION) {
      if (curId != null) sectionSubtotals.set(curId, sectionSubtotal(acc));
      curId = l.id;
      acc = [];
    } else if (curId != null) {
      acc.push(l);
    }
  }
  if (curId != null) sectionSubtotals.set(curId, sectionSubtotal(acc));
  return {
    groupInfo: alternativeGroupInfo(ls),
    setInfo: setGroupInfo(ls),
    sectionSubtotals,
  };
}
