import { productForGrade } from '../../lib/catalog.js';
import { composeSubtype, composeFabricLabel } from '../../lib/subtype.js';

/**
 * The line seed for a CATALOG product pick — the SINGLE source of truth shared
 * by both pickers that add a catalog product to a quote:
 *   • the Catálogo picker (Ligne Roset, graded → fabric/grade step), and
 *   • the Inventario picker's LifestyleGarden tab (non-graded stock).
 * Keeping ONE builder means an LSG line lands identically wherever it's added —
 * crucially its CDN photo POINTERS (imageId/extraImageIds, never bytes) and its
 * second description line — so the two entry points can never drift.
 *
 * `grade`/`material`/`color` are only present for an upholstered Ligne Roset
 * pick; an LSG (or non-graded) pick passes the bare product and they stay empty.
 */
export function productLineSeed(fam, product, grade, material, color) {
  return {
    family: product.family || fam.family,
    reference: product.reference,
    name: product.name,
    dimensions: product.dimensions,
    // The catalog's "Description 2" (finish/variant text) lives in the line's
    // read-only productDescription so it survives a fabric grade taking over the
    // subtype; the subtype slot is the fabric (graded) or empty (non-upholstered).
    subtype: (grade || material)
      ? composeSubtype(grade, composeFabricLabel(material, color))
      : '',
    productDescription: product.subtype || '',
    unitPrice: product.priceUsd,
    unitCost: product.cost,
    // The catalog's own photos (LSG CDN pointers) ride along — cover + the full
    // store gallery — so the line lands fully illustrated; LR rows carry none.
    imageId: product.imageId ?? null,
    extraImageIds: Array.isArray(product.extraImageIds) && product.extraImageIds.length
      ? product.extraImageIds
      : null,
    swatchImageId: color?.imageId ?? null,
  };
}

/**
 * The line seed for a graded model quoted WITHOUT a material — a price RANGE
 * (cheapest grade → priciest). Returns null when the family can't form a range
 * (ungraded or a missing lo/hi price); the caller skips the insert then.
 */
export function rangeLineSeed(fam) {
  const lo = productForGrade(fam, fam.grades[0]);
  const hi = productForGrade(fam, fam.grades[fam.grades.length - 1]);
  if (!lo || !hi) return null;
  const min = Number(lo.priceUsd) || 0;
  const max = Number(hi.priceUsd) || 0;
  return {
    family: lo.family || fam.family,
    reference: lo.reference,
    name: lo.name || fam.name,
    dimensions: lo.dimensions,
    subtype: '',
    productDescription: lo.subtype || '',
    unitPrice: min,
    unitCost: lo.cost,
    imageId: lo.imageId ?? null,
    swatchImageId: null,
    priceMin: min,
    priceMax: max,
  };
}
