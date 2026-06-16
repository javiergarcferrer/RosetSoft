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

import { ALPHA_GRADES, parseSubtype, composeSubtype } from './subtype.js';
import type {
  Product,
  QuoteLine,
  LineComponent,
  MaterialOption,
  MaterialOptions,
} from '../types/domain.ts';

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
  /** Brand catalog the members belong to (products.brand; '' when unknown).
   *  Members never span brands — the root IS a brand's reference. */
  brand: string;
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
      fam = { root, name: p.name || '', family: p.family || '', brand: p.brand || '', grades: [], byGrade: new Map(), graded: false };
      families.set(root, fam);
    }
    if (!fam.name && p.name) fam.name = p.name;
    if (!fam.brand && p.brand) fam.brand = p.brand;
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

/* ------------------------------- stock gate ------------------------------- */

export interface StockState {
  /** True when the brand store tracks this product's inventory (LSG rows
   *  carry stockQty from Shopify; LR rows are special-order → untracked). */
  tracked: boolean;
  /** Sellable units right now — meaningful only when tracked. */
  qty: number;
}

/** Stock of one catalog product. `stockQty == null` ⇒ not tracked. */
export function productStock(p: Pick<Product, 'stockQty'> | null | undefined): StockState {
  const tracked = p?.stockQty != null;
  return { tracked, qty: tracked ? Number(p!.stockQty) || 0 : 0 };
}

/** A TRACKED product with nothing sellable — the quote builder must not
 *  insert it (the dealer can't promise a piece the store doesn't have). */
export function isOutOfStock(p: Pick<Product, 'stockQty'> | null | undefined): boolean {
  const s = productStock(p);
  return s.tracked && s.qty <= 0;
}

/**
 * Stock of a picker MODEL — tracked when any member is (LSG models are
 * single-member families; graded LR models never are), qty summed over the
 * members. Drives the picker rows' stock chip + the out-of-stock disable.
 */
export function familyStock(family: CatalogFamily | null | undefined): StockState {
  let tracked = false;
  let qty = 0;
  for (const p of family ? family.byGrade.values() : []) {
    const s = productStock(p);
    if (s.tracked) { tracked = true; qty += s.qty; }
  }
  return { tracked, qty };
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
  return family.byGrade.get((grade || '').toUpperCase()) || null;
}

/** The line/component patch that reverts a piece to its material-less RANGE. */
export interface MateriallessRangePatch {
  subtype: '';
  swatchImageId: null;
  unitPrice: number;
  unitCost: number | null;
  priceMin: number;
  priceMax: number;
}

/**
 * Patch that strips a chosen material off a line/component and reverts it to the
 * model's cheapest→priciest RANGE (priceMin..priceMax) — the exact shape a "sin
 * material" line is added in. Returns null when the family can't form a range
 * (ungraded, fewer than two grades, or no valid lo/hi price): there's nothing to
 * revert to, so the caller leaves the piece as-is. The single source for every
 * editor clear path (the raw line row AND the client-preview swatch ×), so they
 * can't drift; mirrors the public link's clearMaterial / the server clear branch.
 */
export function materiallessRangePatch(
  family: CatalogFamily | null | undefined,
): MateriallessRangePatch | null {
  if (!family || !family.graded || family.grades.length < 2) return null;
  const lo = productForGrade(family, family.grades[0]);
  const hi = productForGrade(family, family.grades[family.grades.length - 1]);
  if (!lo || !hi || lo.priceUsd == null || hi.priceUsd == null) return null;
  const min = Number(lo.priceUsd) || 0;
  const max = Number(hi.priceUsd) || 0;
  if (!(max > min)) return null;
  return {
    subtype: '',
    swatchImageId: null,
    unitPrice: min,
    unitCost: lo.cost == null ? null : Number(lo.cost),
    priceMin: min,
    priceMax: max,
  };
}

/**
 * Fields the catalog flow rewrites on a line when its product changes.
 * `unitCost` is widened to allow null (the DB column is nullable and we clear
 * it when the new SKU carries no wholesale cost), mirroring how addLine writes
 * it; the QuoteLine type models it as an optional number.
 */
export type ProductSwitchPatch = Pick<
  QuoteLine,
  | 'family'
  | 'reference'
  | 'name'
  | 'dimensions'
  | 'subtype'
  | 'unitPrice'
  | 'swatchImageId'
  | 'materialOptions'
> & { unitCost: number | null };

function numOr0(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the line patch for switching a line to a different catalog MODEL,
 * KEEPING the materials the new model can actually be quoted in and DROPPING
 * the rest — the counterpart to the catalog insert flow, for an existing line.
 *
 * "Compatible" = the new model offers a priced SKU at that material's grade
 * (the family carries that grade). The base material is kept when its grade
 * survives; otherwise the first surviving option is promoted into the base
 * slot so a still-valid material stays quoted. The option list is filtered to
 * the survivors. When nothing survives (e.g. switching to a non-upholstered
 * model, or a model that shares none of the line's grades) the material is
 * cleared and the line falls back to the model's own subtype.
 *
 * Price/cost/reference/name/dimensions are re-snapshotted from the new model's
 * SKU for the surviving base grade — or the cheapest grade when no material
 * survives — so the line always carries a real catalog price, mirroring
 * CatalogPicker's insertProduct.
 */
/**
 * Reprice a compound's COMPONENTS to a picked grade+fabric — the pure pipeline
 * behind "aplicar material a todas" (composition header AND per-component
 * copy-to-all), mirroring what GradeFabricRow.commit does for one piece. A
 * grade is a price tier, so every component re-snapshots reference + price to
 * ITS OWN model at that grade (left intact when its family doesn't carry it)
 * and any material-less range drops; the fabric + swatch stamp regardless.
 * Pure — the caller persists the returned components.
 */
export function repriceComponentsAtGrade(
  components: readonly LineComponent[] | null | undefined,
  pick: { grade?: string | null; fabric?: string | null; swatchImageId?: string | null },
  families: ReadonlyMap<string, CatalogFamily> | null | undefined,
): LineComponent[] {
  const comps = Array.isArray(components) ? components : [];
  const subtype = composeSubtype(pick.grade, pick.fabric);
  const swatch = pick.swatchImageId ?? null;
  return comps.map((c) => {
    const patch: Partial<LineComponent> = { subtype, swatchImageId: swatch };
    if (pick.grade) {
      const fam = families?.get(splitSkuGrade(c.reference).root) || null;
      const p = fam ? productForGrade(fam, pick.grade) : null;
      // Reprice to this component's own SKU at the grade (no-op when the grade
      // is unchanged; left intact when its model doesn't carry the grade).
      if (p) {
        patch.reference = p.reference;
        patch.unitPrice = Number(p.priceUsd) || 0;
      }
      if (c.priceMin != null || c.priceMax != null) {
        patch.priceMin = null;
        patch.priceMax = null;
      }
    }
    return { ...c, ...patch };
  });
}

export function switchLineProduct(
  line: Pick<QuoteLine, 'subtype' | 'swatchImageId' | 'materialOptions'>,
  family: CatalogFamily | null | undefined,
): ProductSwitchPatch | null {
  if (!family) return null;

  // Non-graded model (table, lamp, wood chair): it has no fabric grades, so no
  // upholstery material applies. Drop them all and take the model's own
  // subtype (its finish/variant text), as the insert flow does.
  if (!family.graded) {
    const p = productForGrade(family, '');
    return {
      family: p?.family || family.family || '',
      reference: p?.reference || '',
      name: p?.name || family.name || '',
      dimensions: p?.dimensions || '',
      subtype: p?.subtype || '',
      unitPrice: numOr0(p?.priceUsd),
      unitCost: p?.cost ?? null,
      swatchImageId: null,
      materialOptions: null,
    };
  }

  const offered = new Set(family.grades.map((g) => g.toUpperCase()));
  const fits = (g: string | null | undefined): boolean =>
    !!g && offered.has(g.toUpperCase());

  const { grade: baseGrade, fabric: baseFabric } = parseSubtype(line.subtype);
  const options: MaterialOption[] = line.materialOptions?.options ?? [];
  const keptOptions = options.filter((o) => fits(o.grade));

  let newGrade: string;
  let newFabric: string;
  let newSwatchId: string | null;
  let remaining: MaterialOption[];

  if (fits(baseGrade)) {
    // The line's own material survives — keep it (and its swatch) verbatim.
    newGrade = baseGrade.toUpperCase();
    newFabric = baseFabric;
    newSwatchId = line.swatchImageId ?? null;
    remaining = keptOptions;
  } else if (keptOptions.length) {
    // Base dropped but a compatible option remains — promote it to the base
    // slot so a valid material stays quoted; the rest stay as options.
    const promoted = keptOptions[0];
    newGrade = (promoted.grade || '').toUpperCase();
    newFabric = promoted.label || '';
    newSwatchId = promoted.swatchImageId ?? null;
    remaining = keptOptions.slice(1);
  } else {
    // Nothing survives — clear the material; the dealer re-picks a fabric.
    newGrade = '';
    newFabric = '';
    newSwatchId = null;
    remaining = [];
  }

  // Price/identity from the surviving base grade, or the cheapest grade when no
  // material survived (grades are sorted ascending by price).
  const priceGrade = newGrade || family.grades[0] || '';
  const p = productForGrade(family, priceGrade);

  // Reset the delta base to the line's actual current material — both healing
  // any prior base/subtype drift and re-anchoring the kept options' deltas.
  const materialOptions: MaterialOptions | null = remaining.length
    ? { baseGrade: newGrade, baseLabel: newFabric, options: remaining }
    : null;

  return {
    family: p?.family || family.family || '',
    reference: p?.reference || '',
    name: p?.name || family.name || '',
    dimensions: p?.dimensions || '',
    subtype: composeSubtype(newGrade, newFabric),
    unitPrice: numOr0(p?.priceUsd),
    unitCost: p?.cost ?? null,
    swatchImageId: newSwatchId,
    materialOptions,
  };
}

/** Fields filled on a line/component when a SKU is pasted/typed into Ref. */
export interface SkuFillPatch {
  family?: string;
  reference: string;
  name?: string;
  dimensions?: string;
  subtype?: string;
  unitPrice?: number;
  unitCost?: number | null;
  swatchImageId?: null;
  materialOptions?: null;
  priceMin?: null;
  priceMax?: null;
}

/**
 * Resolve a pasted/typed SKU to its catalog product and return the line/
 * component fields to fill — so pasting "10002953E" IMMEDIATELY pulls up the
 * product (name, dimensions, grade, list price, cost). Keys on root+grade via
 * `splitSkuGrade` → `productForGrade`. Pins the grade as the subtype (no fabric)
 * and clears any prior material / range, since a concrete SKU fixes grade +
 * price. When the SKU isn't in the catalog (or a graded root carries no grade
 * letter to resolve), returns just `{ reference }` so a free-typed reference is
 * preserved untouched.
 */
export function skuFillPatch(
  families: ReadonlyMap<string, CatalogFamily> | null | undefined,
  sku: string | null | undefined,
): SkuFillPatch {
  const reference = (sku || '').trim();
  const { root, grade } = splitSkuGrade(reference);
  const fam = families ? families.get(root) : null;
  const p = fam ? productForGrade(fam, grade) : null;
  if (!p) return { reference };
  return {
    family: p.family || fam!.family || '',
    reference: p.reference,
    name: p.name || '',
    dimensions: p.dimensions || '',
    subtype: grade ? composeSubtype(grade, '') : (p.subtype || ''),
    unitPrice: numOr0(p.priceUsd),
    unitCost: p.cost ?? null,
    swatchImageId: null,
    materialOptions: null,
    priceMin: null,
    priceMax: null,
  };
}

/**
 * Normalize a fabric / material name for name-matching: uppercased, the embedded
 * "(#code)" and the "· COLOR" tail dropped, a trailing " — A" grade suffix
 * removed (some roster names carry their grade in the label), whitespace
 * collapsed. So "Phlox", "PHLOX (#12)", "PHLOX · ECRU" and "PHLOX — G" all key
 * to "PHLOX".
 */
function normFabricName(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\(#[^)]*\)/g, ' ')             // drop the embedded colour code
    .split('·')[0]                            // drop the "· COLOR" tail
    .replace(/\s*[—–-]\s*[A-Za-z]\s*$/, '')   // drop a trailing " — A" grade suffix
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/** A material as seen by the grade resolver — just its name + grade tier. */
export interface GradedMaterial {
  name?: string | null;
  grade?: string | null;
}

/**
 * The GRADE (price tier) a fabric belongs to, resolved off the materials roster
 * by name. An invoice names a fabric (PHLOX, DIVA) but the catalog prices
 * upholstery by grade (A, G, …), so this is the bridge between them. Matches on
 * the normalized name (so a roster's "(#code)"/grade-suffixed label still hits)
 * and returns the material's grade, or '' when the fabric isn't on the roster or
 * carries no grade. Pure.
 */
export function gradeForFabric(
  materials: readonly GradedMaterial[] | null | undefined,
  fabric: string | null | undefined,
): string {
  const key = normFabricName(fabric);
  if (!key) return '';
  for (const m of materials || []) {
    if (m?.grade && normFabricName(m.name) === key) return String(m.grade).trim().toUpperCase();
  }
  return '';
}

/**
 * The catalog SELLING price (USD list price) an inventory item minted from an
 * import invoice line should carry — "use the catalog price for the product".
 * The invoice supplies a bare model REFERENCE and the FABRIC it shipped in,
 * while the catalog prices upholstery by GRADE, so:
 *   • a full SKU (root+grade) or a NON-graded model resolves its price directly;
 *   • a GRADED model resolves the fabric's grade (via the materials roster) and
 *     reads that grade's SKU price.
 * Returns null when nothing resolves — an unknown model, or a graded model whose
 * fabric can't be graded — so the caller leaves the price unset rather than
 * stamping a wrong one. Pure.
 */
export function catalogSellingPrice(
  families: ReadonlyMap<string, CatalogFamily> | null | undefined,
  materials: readonly GradedMaterial[] | null | undefined,
  reference: string | null | undefined,
  fabric?: string | null,
): number | null {
  const { root, grade } = splitSkuGrade((reference || '').trim());
  const fam = families ? families.get(root) : null;
  if (!fam) return null;
  // The grade to price at: an explicit SKU grade wins; a graded model otherwise
  // needs the fabric's grade; a non-graded model ignores the grade entirely.
  let g = grade;
  if (!g && fam.graded) {
    g = gradeForFabric(materials, fabric);
    if (!g) return null; // a graded model can't be priced without its grade
  }
  const p = productForGrade(fam, g);
  if (!p || p.priceUsd == null) return null;
  return Number(p.priceUsd) || 0;
}

/**
 * The catalog's "Description 2" (the model's finish/variant text, e.g. "STANDARD
 * HEADBOARD") for a SKU, pulled live from the price-list families — i.e. what
 * the product itself carries. This is the read-only secondary descriptor a quote
 * line snapshots into `productDescription` on insert.
 *
 * Also used to recognise a LEGACY line whose editable `description` was
 * auto-filled with this exact text (before the two fields were split), so the
 * editor can move it into `productDescription` and free the dealer's field.
 * Empty string when the SKU isn't in the catalog.
 */
export function catalogProductDescription(
  families: ReadonlyMap<string, CatalogFamily> | null | undefined,
  reference: string | null | undefined,
): string {
  const { root, grade } = splitSkuGrade((reference || '').trim());
  const fam = families ? families.get(root) : null;
  const p = fam ? productForGrade(fam, grade) : null;
  return (p?.subtype || '').trim();
}
