/**
 * Catalog family grouping — turns the flat product list (one row per priced
 * SKU) into MODELS (families) the quote builder picks from.
 *
 * Upholstered SKUs are "8-digit root + grade letter": e.g. the Togo Fireside
 * Chair is root `15420000` with one SKU per fabric grade (15420000A,
 * 15420000G, …). The trailing letter is the grade and maps 1:1 to the app's
 * GRADE_GROUPS / Material.grade taxonomy (A–R Telas, S Microfibra, U–X Pieles)
 * — so picking a fabric of a given grade resolves to that SKU's price.
 *
 * Non-graded SKUs (wood chairs, tables, lighting — 8-char alphanumeric codes
 * or 9-char codes whose tail isn't a grade) are their own single-member
 * family with grade ''.
 */

import { ALPHA_GRADES } from './subtype.js';
import type { Product } from '../types/domain.ts';

const GRADE_SET: ReadonlySet<string> = new Set(ALPHA_GRADES);

/**
 * Split a SKU into its family root and grade. Only an "8 digits + grade
 * letter" SKU is treated as graded; everything else is its own root with an
 * empty grade.
 */
export function splitSkuGrade(sku: string | null | undefined): { root: string; grade: string } {
  const s = (sku || '').trim();
  const m = /^(\d{8})([A-Za-z])$/.exec(s);
  if (m && GRADE_SET.has(m[2].toUpperCase())) {
    return { root: m[1], grade: m[2].toUpperCase() };
  }
  return { root: s, grade: '' };
}

export interface CatalogFamily {
  /** Family root — the 8-digit SKU prefix (or the whole SKU when ungraded). */
  root: string;
  /** Display name (Description 1 of the members). */
  name: string;
  family: string;
  /** Grade letters this model is offered in, in price order (asc). */
  grades: string[];
  /** grade letter → the product (SKU variant) for that grade. */
  byGrade: Map<string, Product>;
  /** True when the model has real fabric-grade variants (upholstered). */
  graded: boolean;
}

/**
 * Group products into families by SKU root. Members are bucketed by grade;
 * grades are returned in ascending price order (so the cheapest grade leads).
 */
export function groupFamilies(products: readonly Product[] | null | undefined): CatalogFamily[] {
  const families = new Map<string, CatalogFamily>();
  for (const p of products || []) {
    const { root, grade } = splitSkuGrade(p.reference);
    let fam = families.get(root);
    if (!fam) {
      fam = { root, name: p.name || '', family: p.family || '', grades: [], byGrade: new Map(), graded: false };
      families.set(root, fam);
    }
    if (!fam.name && p.name) fam.name = p.name;
    // Key by grade letter, or '' for a truly ungraded SKU.
    fam.byGrade.set(grade || '', p);
  }
  for (const fam of families.values()) {
    fam.grades = [...fam.byGrade.keys()]
      .filter((g) => g !== '')
      .sort((a, b) => priceOf(fam.byGrade.get(a)) - priceOf(fam.byGrade.get(b)));
    // A model is grade-priced only when several grade variants share the
    // root. A lone SKU that merely ends in a grade letter (a wood chair's
    // finish code, say) is a standalone product, not a fabric-graded model.
    fam.graded = fam.grades.length >= 2;
  }
  return [...families.values()];
}

function priceOf(p: Product | undefined): number {
  const n = Number(p?.priceUsd);
  return Number.isFinite(n) ? n : 0;
}

/** The grade letters a model offers — what the fabric picker filters to. */
export function availableGrades(family: CatalogFamily | null | undefined): string[] {
  return family && family.graded ? family.grades : [];
}

/**
 * Resolve a model + chosen grade to its specific SKU/product (price + cost).
 * For a non-graded standalone family, returns its sole member regardless of
 * the grade argument.
 */
export function productForGrade(
  family: CatalogFamily | null | undefined,
  grade: string,
): Product | null {
  if (!family) return null;
  if (!family.graded) return [...family.byGrade.values()][0] || null;
  return family.byGrade.get(grade) || null;
}
