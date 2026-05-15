/**
 * Pricing math used by the quote builder and the PDF generator.
 *
 * Variant pricing table shape (stored on productVariant.priceByGrade):
 *   { A: 6445, B: 6645, ..., Z: ... }
 *
 * Lines reference a material (which has a grade letter) to look up base price.
 * COM/COL (customer's own material) is supported via line.priceOverride.
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

export function variantPriceForGrade(variant, grade) {
  if (!variant?.priceByGrade) return null;
  return variant.priceByGrade[grade] ?? null;
}

/**
 * Resolve the base price for a quote line given its variant + material.
 *
 *   priceOverride          → wins outright (COM/COL or user override)
 *   variant + material.grade → look up the grade column on the variant
 *   variant.priceFixed     → single-price variants (cabinetry, accessories)
 *   fallbackToLowestGrade  → optionally show the cheapest grade when no
 *                            material has been picked yet (cart preview)
 */
export function resolveLineBasePrice(
  { variant, material, priceOverride },
  { fallbackToLowestGrade = false } = {},
) {
  if (priceOverride != null) return priceOverride;
  if (variant && material?.grade) return variantPriceForGrade(variant, material.grade) ?? 0;
  if (variant?.priceFixed != null) return variant.priceFixed;
  if (fallbackToLowestGrade && variant) {
    const vals = Object.values(variant.priceByGrade || {});
    return vals.length ? Math.min(...vals) : 0;
  }
  return 0;
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

/** A fabric "is allowed" on a product when:
 *    - the product is not in the material's `restrictedToProductNames`, AND
 *    - the material is not in the product's `technicalImpossibilities` (case-insensitive)
 */
export function isMaterialAllowed(product, material) {
  if (!product || !material) return true;
  const impossibles = (product.technicalImpossibilities || []).map((s) => s.toUpperCase());
  if (impossibles.includes((material.name || '').toUpperCase())) return false;
  const restricted = material.restrictedToProductNames || [];
  if (restricted.length && !restricted.map((s) => s.toUpperCase()).includes((product.name || '').toUpperCase())) {
    return false;
  }
  return true;
}

export const GRADES = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
