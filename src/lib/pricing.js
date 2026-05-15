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
 * @param {Array} lines  resolved line items: { qty, basePrice, lineMarginPct, lineDiscountPct }
 * @param {Object} quote { marginPct, discountPct, taxPct, shipping, currencyCode, rates }
 * @returns {Object} { subtotal, marginAmt, discountAmt, taxableBase, taxAmt, shipping, grandTotal }
 */
export function computeTotals(lines, quote = {}) {
  const subtotal = lines.reduce((acc, l) => {
    const unit = applyLineAdjustments(l.basePrice, l.lineMarginPct, l.lineDiscountPct);
    return acc + unit * (l.qty || 0);
  }, 0);

  const marginAmt = subtotal * ((quote.marginPct || 0) / 100);
  const afterMargin = subtotal + marginAmt;
  const discountAmt = afterMargin * ((quote.discountPct || 0) / 100);
  const taxableBase = afterMargin - discountAmt;
  // ITBIS is fixed at 18% — hardcoded for Dominican Republic
  const taxAmt = taxableBase * (ITBIS_PCT / 100);
  const shipping = quote.shipping || 0;
  const grandTotal = taxableBase + taxAmt + shipping;

  return { subtotal, marginAmt, discountAmt, taxableBase, taxAmt, shipping, grandTotal, taxPct: ITBIS_PCT };
}

export function applyLineAdjustments(basePrice, marginPct, discountPct) {
  if (basePrice == null) return 0;
  const withMargin = basePrice * (1 + (marginPct || 0) / 100);
  return withMargin * (1 - (discountPct || 0) / 100);
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
