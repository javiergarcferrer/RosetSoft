// resolveLineItem — the per-line display ViewModel for the quote-builder line
// editor (components/quote-builder/QuoteLineItem.jsx).
//
// MVVM: QuoteLineItem is the INTERACTIVE line editor — it owns all the state,
// event handlers, pickers and mutation callbacks. This module owns ONLY the
// pure, render-time DERIVATION: the computed money + flags the card reads top
// to bottom (is this line compound / a range / dimmed, its adjusted unit and
// subtotal, the min–max for a range, the compound roll-up, and a parallel
// per-component projection). It composes the Model's pricing primitives
// (lib/pricing) — it NEVER re-implements pricing math — so the figures here can
// never diverge from the totals, the client preview or the PDF.
//
// Pure: no React, no db, no I/O. Everything is a function of the raw `line`
// (which carries its own qty / unitPrice / margin / discount / components).
// Currency formatting is intentionally NOT here — the view formats the numbers
// this VM returns through its own `formatMoney` closure, so the VM stays a
// plain-data projection independent of the quote's rate.
import {
  applyLineAdjustments,
  isCompoundLine, componentSubtotal,
  lineTotal,
  isRangeLine, lineTotalRange, isRangeComponent, componentSubtotalRange, lineHasRange,
  componentAlternativeGroupInfo,
} from '../../../lib/pricing.js';
import { canPropagateMaterial } from '../../../lib/subtype.js';

// Per-component display projection for a compound's sub-pieces — the pure
// derivation ComponentRow used to compute inline (total, the optional/
// alternative flags + dim state, the range swap), plus the "Opción N de M"
// position map resolved once for the whole panel (componentAlternativeGroupInfo,
// keyed by component id). Components keep their own id so the view can still key
// rows and look each derived entry up; handlers/state/pickers stay in the view.
function resolveComponents(components) {
  const list = Array.isArray(components) ? components : [];
  const altInfo = componentAlternativeGroupInfo(list);
  return list.map((c) => {
    const inGroup = !!c.alternativeGroup;
    const isSelected = !!c.isSelectedAlternative;
    const hasRange = isRangeComponent(c);
    return {
      id: c.id,
      // Pricing: a material-less sub-piece shows a range, else a single total —
      // the same swap the standalone line makes, one level down.
      total: componentSubtotal(c),
      hasRange,
      range: hasRange ? componentSubtotalRange(c) : null,
      // Option flags + the resulting "off" (dimmed) state — an excluded optional
      // or a non-selected alternative reads as deactivated.
      optional: !!c.isOptional,
      inGroup,
      isSelected,
      dimmed: inGroup && !isSelected,
      // "Opción N de M" position ({ index, total }) or undefined when ungrouped.
      groupInfo: altInfo.get(c.id),
      // Offer "apply this material to every component" only when it would
      // actually change a sibling — the SMART affordance that kills the busywork
      // of re-picking the same fabric across a compound's pieces.
      canApplyToAll: canPropagateMaterial(c, list),
    };
  });
}

/**
 * Resolve a quote line into the display fields the card renders.
 *
 * @param line  the raw quote line (item or compound).
 * @returns {{
 *   isCompound: boolean,
 *   isRange: boolean,          // material-less single line → show the range band
 *   dimmed: boolean,           // optional / non-selected alternative → veiled
 *   unitNet: number,           // unit price after line margin + discount
 *   subtotal: number,          // the line's own total (compound-aware)
 *   range: { min, max } | null,// non-null only for a material-less single line
 *   hasAdjustment: boolean,    // a live discount or a legacy margin to surface
 *   margin: number,
 *   discount: number,
 *   compound: { count, hasRange, range: {min,max}|null },
 *   components: Array<object>,  // per-component projection (see resolveComponents)
 * }}
 */
export function resolveLineItem(line) {
  const l = line || {};
  const isCompound = isCompoundLine(l);

  // Adjusted unit price (line-level margin then discount) and the line's own
  // total. A compound ignores its own qty/unitPrice and rolls up its priced
  // components (lineTotal handles that branch); a normal line is unit × qty.
  const unitNet = applyLineAdjustments(l.unitPrice, l.lineMarginPct, l.lineDiscountPct);
  const subtotal = isCompound ? lineTotal(l) : unitNet * (l.qty || 0);

  // Material-less RANGE line — priced cheapest→priciest grade until a fabric is
  // picked. Shows a range band instead of the qty × unit = total calculator.
  // (A compound never takes this branch; its range lives on the compound roll-up.)
  const isRange = !isCompound && isRangeLine(l);
  const range = isRange ? lineTotalRange(l) : null;

  // Only surface the adjustment caption/chip when there's a live discount or a
  // legacy margin to explain — new lines never set margin, but old quotes may.
  const discount = Number(l.lineDiscountPct) || 0;
  const margin = Number(l.lineMarginPct) || 0;
  const hasAdjustment = discount !== 0 || margin !== 0;

  // Deactivated (optional) or non-selected alternative: the row reads as "off".
  const dimmed = !!l.isOptional || (!!l.alternativeGroup && !l.isSelectedAlternative);

  // Compound roll-up: how many components, and — when any priced component is
  // material-less — the compound's own price range (lineTotalRange collapses to
  // a point otherwise, so a fully-specified compound carries range: null).
  const compoundRanged = isCompound && lineHasRange(l);
  const compound = {
    count: isCompound ? (l.components || []).length : 0,
    hasRange: compoundRanged,
    range: compoundRanged ? lineTotalRange(l) : null,
  };

  return {
    isCompound,
    isRange,
    dimmed,
    unitNet,
    subtotal,
    range,
    hasAdjustment,
    margin,
    discount,
    compound,
    components: isCompound ? resolveComponents(l.components) : [],
  };
}
