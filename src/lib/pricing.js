/**
 * Pricing math used by the quote builder and the PDF generator.
 *
 * Lines are user-typed (no normalized catalog). Each line carries its own
 * `unitPrice` straight from the Ligne Roset price-list PDF that the user is
 * reading; line and quote-level margin/discount layer on top of that.
 *
 * ITBIS (Dominican Republic value-added tax) is fixed at 18% and applied to
 * every quote — there is no per-quote override.
 */

export const ITBIS_PCT = 18;

/** Coerce to a finite number, falling back to a default if not. */
function safeNum(v, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Clamp a percentage to [0, max] (default 100). Used for discount fields
 * where a negative value would invert the operation and a >100% value is
 * never meaningful. Exported so input widgets can mirror the clamp.
 */
export function clampPct(v, max = 100) {
  const n = safeNum(v, 0);
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}

/**
 * Compute totals for a quote.
 *
 * Order of operations matters when both margin and discount are non-zero:
 *
 *   lineUnit      = applyLineAdjustments(basePrice, lineMarginPct, lineDiscountPct)
 *   subtotal      = Σ( lineUnit × qty )
 *   afterMargin   = subtotal × (1 + marginPct/100)        // margin lifts the bill
 *   afterDiscount = afterMargin × (1 − discountPct/100)   // discount eats into the lifted total
 *   taxAmt        = afterDiscount × (ITBIS/100)
 *   grandTotal    = afterDiscount + taxAmt + shipping
 *
 * Constraints (defense in depth — inputs are also clamped at the UI layer):
 *   - marginPct:   free range (negative = loss-leader / clearance is legitimate)
 *   - discountPct: clamped to [0, 100]
 *   - line pcts:   same rules as quote-level pcts
 *   - shipping:    clamped to [0, ∞)
 *   - non-finite numeric inputs are treated as 0 (never NaN-out a quote)
 *
 * @param {Array} lines  resolved line items: { qty, basePrice, lineMarginPct, lineDiscountPct }
 * @param {Object} quote { marginPct, discountPct, shipping }
 *                       (taxPct is intentionally ignored — ITBIS is fixed)
 * @returns {Object} { subtotal, marginAmt, discountAmt, taxableBase, taxAmt, shipping, grandTotal, taxPct }
 */
export function computeTotals(lines, quote = {}) {
  const subtotal = (lines || []).reduce((acc, l) => {
    const unit = applyLineAdjustments(l?.basePrice, l?.lineMarginPct, l?.lineDiscountPct);
    return acc + unit * safeNum(l?.qty, 0);
  }, 0);

  const marginPct = safeNum(quote.marginPct, 0);
  const discountPct = clampPct(quote.discountPct);

  const marginAmt = subtotal * (marginPct / 100);
  const afterMargin = subtotal + marginAmt;
  const discountAmt = afterMargin * (discountPct / 100);
  const taxableBase = afterMargin - discountAmt;
  const taxAmt = taxableBase * (ITBIS_PCT / 100);
  const shipping = Math.max(0, safeNum(quote.shipping, 0));
  const grandTotal = taxableBase + taxAmt + shipping;

  return {
    subtotal: safeNum(subtotal),
    marginAmt: safeNum(marginAmt),
    discountAmt: safeNum(discountAmt),
    taxableBase: safeNum(taxableBase),
    taxAmt: safeNum(taxAmt),
    shipping,
    grandTotal: safeNum(grandTotal),
    taxPct: ITBIS_PCT,
  };
}

export function applyLineAdjustments(basePrice, marginPct, discountPct) {
  const base = safeNum(basePrice, 0);
  const margin = safeNum(marginPct, 0);
  const discount = clampPct(discountPct);
  const withMargin = base * (1 + margin / 100);
  return withMargin * (1 - discount / 100);
}

/* --------------------------- compound lines --------------------------- */

/**
 * A "compound" line is one product family (and one photo) that bundles
 * several priced rows underneath — TOGO settee + loveseat + ottoman, a
 * modular sectional split across modules + chaise, etc. The components
 * live in `line.components` as a JSON array; each carries its own name,
 * reference, subtype, dimensions, qty, unit price.
 *
 * When the array is non-empty, the line's own qty / unitPrice are
 * ignored and the line's base subtotal is the sum of component
 * subtotals. Line-level margin / discount still apply on top.
 */
export function isCompoundLine(line) {
  return Array.isArray(line?.components) && line.components.length > 0;
}

export function componentSubtotal(component) {
  return safeNum(component?.unitPrice, 0) * safeNum(component?.qty, 0);
}

export function compoundSubtotal(line) {
  if (!isCompoundLine(line)) return 0;
  return line.components.reduce((sum, c) => sum + componentSubtotal(c), 0);
}

/**
 * Per-unit base price for a line. For a normal line this is unitPrice;
 * for a compound it's the sum of component subtotals (with qty=1, since
 * the components carry their own quantities).
 */
export function lineBasePrice(line) {
  if (isCompoundLine(line)) return compoundSubtotal(line);
  return safeNum(line?.unitPrice, 0);
}

/** Effective quantity multiplier for a line — always 1 for compounds. */
export function lineQty(line) {
  if (isCompoundLine(line)) return 1;
  return safeNum(line?.qty, 0);
}

/**
 * Pre-line-adjustment subtotal: lineBasePrice × lineQty. Useful in
 * places (breakdown popovers, totals rails) that need the
 * pre-discount figure for a compound or a normal line uniformly.
 */
export function lineSubtotal(line) {
  return lineBasePrice(line) * lineQty(line);
}

/** Final per-line total, after line-level margin and discount. */
export function lineTotal(line) {
  const base = lineBasePrice(line);
  return applyLineAdjustments(base, line?.lineMarginPct, line?.lineDiscountPct) * lineQty(line);
}

/**
 * Map a raw quote line (item or compound) onto the shape `computeTotals`
 * expects. Centralizes the compound-vs-normal branch so call sites
 * (QuoteBuilder, Dashboard, ProfessionalDetail, Commissions, ClientPreview)
 * don't each have to redo the math.
 */
export function lineForTotals(line) {
  return {
    qty: lineQty(line),
    basePrice: lineBasePrice(line),
    lineMarginPct: line?.lineMarginPct,
    lineDiscountPct: line?.lineDiscountPct,
  };
}

