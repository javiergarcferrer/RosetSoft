/**
 * Element kits — the "complete element ↔ its separate parts" map for modular
 * Ligne Roset models (EXCLUSIF and friends).
 *
 * A modular element is sold two ways on the price list: as ONE *complete
 * element* SKU (a small bundle discount) OR as the SEPARATE part SKUs that
 * compose it (frame + seat cushion, back cushion, scatter cushion …). The
 * sum of the parts is always a little MORE than the complete element — that
 * gap is the price of customizing one part (a different fabric on the back
 * cushion, say), because the moment a part diverges you can no longer buy the
 * complete SKU and must quote it à la carte.
 *
 * The link between a complete SKU and its parts is NOT derivable from the SKU
 * numbers — e.g. the EXCLUSIF Corner Seat is tidy (`17220600` → `…610`/`…620`)
 * but the Right-Arm Loveseat jumps ranges (`10002953` → `10003013` + cushions
 * in the `1722…` range). So the mapping is captured here as data, keyed by the
 * grade-stripped SKU root (`splitSkuGrade`), grade-independent — one kit covers
 * every grade because each part is its own graded family priced at the chosen
 * grade.
 *
 * WHY A CODE CONSTANT (for now): a kit lives entirely on the client — explode /
 * recompose resolve part prices from the already-loaded catalog (`products`),
 * so the whole feature ships in the bundle with no schema change and works on a
 * Vercel *preview* deploy (a new table would only auto-apply on `main`). When
 * this graduates to production it can move to a `element_kits` table with
 * capture-on-explode; `kitForReference` is the single lookup to repoint then.
 *
 * Seed kits below are PROVEN from a real hand-built quote (#1016): each
 * complete element and its by-pieces breakdown sat side by side, so the roots
 * and their order (frame+seat · back cushion · scatter) are taken from there.
 */

import { splitSkuGrade } from './catalog.js';
import { parseSubtype } from './subtype.js';
import type { LineComponent, Product } from '../types/domain.ts';

/** Coerce to a finite number, else a fallback. Mirrors lib/pricing. */
function safeNum(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * One kit: a complete-element SKU root and the ordered roots of the part SKUs
 * it decomposes into. Roots are grade-stripped (`splitSkuGrade(sku).root`).
 */
export interface ElementKit {
  /** Grade-stripped root of the complete-element SKU (e.g. `10002953`). */
  completeRoot: string;
  /** Part roots in display order: frame+seat, back cushion, scatter, … */
  partRoots: string[];
}

/**
 * Seeded EXCLUSIF kits (from quote #1016). complete root → its part roots:
 *   10002953 Right-Arm Loveseat → frame 10003013 · back 17220220 · scatter 17220000
 *   17220600 Corner Seat 45°    → frame 17220610 · back 17220620 · scatter 17220000
 *   10002950 Loveseat w/o Arms  → frame 10003010 · back 17220220 · scatter 17220000
 *   10003972 Mini Lounge Left   → frame 10003992 · back 17220520 · scatter 17220000
 */
export const ELEMENT_KITS: readonly ElementKit[] = [
  { completeRoot: '10002953', partRoots: ['10003013', '17220220', '17220000'] },
  { completeRoot: '17220600', partRoots: ['17220610', '17220620', '17220000'] },
  { completeRoot: '10002950', partRoots: ['10003010', '17220220', '17220000'] },
  { completeRoot: '10003972', partRoots: ['10003992', '17220520', '17220000'] },
];

const KIT_BY_ROOT: ReadonlyMap<string, ElementKit> = new Map(
  ELEMENT_KITS.map((k) => [k.completeRoot, k]),
);

/**
 * Resolve a part SKU root + grade to its catalog product (price/name/dims).
 * The View builds this from `groupFamilies(products)` keyed by root, so the
 * Model stays catalog-agnostic and unit-testable with a fake resolver.
 */
export type PartResolver = (root: string, grade: string) => Product | null;

/** Generates a fresh id for a new component — the app passes `newId`. */
export type IdFactory = () => string;

/**
 * The kit for a SKU reference, or null. Keys on the grade-stripped ROOT, so a
 * reference with any grade letter (or a stale one) still resolves. This is the
 * single lookup to repoint at a DB table later.
 */
export function kitForReference(reference: string | null | undefined): ElementKit | null {
  const { root } = splitSkuGrade(reference);
  return KIT_BY_ROOT.get(root) || null;
}

/** True when this piece is a complete element that can be split into parts. */
export function hasKit(reference: string | null | undefined): boolean {
  return kitForReference(reference) != null;
}

/**
 * The grade a piece is quoted in. The chosen MATERIAL (subtype) is the source
 * of truth — a reference's trailing grade letter can be stale (seen in #1016,
 * where by-pieces refs ended `…A` while priced at Grade I) — so prefer the
 * subtype's grade and fall back to the reference's letter.
 */
export function gradeOf(piece: Pick<LineComponent, 'subtype' | 'reference'> | null | undefined): string {
  const fromSubtype = parseSubtype(piece?.subtype).grade;
  if (fromSubtype) return fromSubtype;
  return splitSkuGrade(piece?.reference).grade;
}

/**
 * USD separation gap at a grade: Σ(part list prices) − complete list price.
 * Positive (parts cost more) is the normal case — that's the upcharge for
 * customizing. Pure over resolved Products so it's independent of components.
 */
export function separationDeltaUsd(
  completeProduct: Product | null | undefined,
  partProducts: ReadonlyArray<Product | null | undefined>,
): number {
  const complete = safeNum(completeProduct?.priceUsd);
  const parts = (partProducts || []).reduce((s, p) => s + safeNum(p?.priceUsd), 0);
  return parts - complete;
}

/**
 * Build the part components that REPLACE a complete-element component when it's
 * exploded. Each part inherits the complete piece's material (subtype + swatch)
 * — exploding doesn't re-pick fabric, it just itemizes — and carries the
 * recompose bookkeeping (`kitGroup` links the run, `kitCompleteRoot` remembers
 * which complete SKU to fold back to). Prices come from the catalog at the
 * piece's current grade. Returns null when ANY part has no price at that grade
 * (so the caller keeps the complete element untouched rather than half-explode).
 */
export function buildPartComponents(
  complete: LineComponent,
  kit: ElementKit,
  resolve: PartResolver,
  newId: IdFactory,
): LineComponent[] | null {
  const grade = gradeOf(complete);
  const kitGroup = newId();
  const out: LineComponent[] = [];
  for (const root of kit.partRoots) {
    const prod = resolve(root, grade);
    if (!prod) return null;
    out.push({
      id: newId(),
      name: prod.name || '',
      reference: prod.reference,
      subtype: complete.subtype || '',
      swatchImageId: complete.swatchImageId ?? null,
      dimensions: prod.dimensions || '',
      qty: 1,
      unitPrice: safeNum(prod.priceUsd),
      kitGroup,
      kitCompleteRoot: kit.completeRoot,
    });
  }
  return out;
}

/**
 * Build the single complete-element component that RECOMPOSES a kit group —
 * the inverse of buildPartComponents. Takes the group's part members, reads the
 * complete root they remember (`kitCompleteRoot`) and their shared grade, and
 * resolves the complete SKU's price/name from the catalog. Inherits the
 * material off the first member. Returns null if the group is empty, carries no
 * complete root, or the complete SKU has no price at the grade.
 */
export function buildCompleteComponent(
  members: ReadonlyArray<LineComponent>,
  resolve: PartResolver,
  newId: IdFactory,
): LineComponent | null {
  if (!members || members.length === 0) return null;
  const first = members[0];
  const completeRoot = first.kitCompleteRoot;
  if (!completeRoot) return null;
  const prod = resolve(completeRoot, gradeOf(first));
  if (!prod) return null;
  return {
    id: newId(),
    name: prod.name || '',
    reference: prod.reference,
    subtype: first.subtype || '',
    swatchImageId: first.swatchImageId ?? null,
    dimensions: prod.dimensions || '',
    qty: 1,
    unitPrice: safeNum(prod.priceUsd),
  };
}

/**
 * Explode one complete-element component within a components array into its
 * parts, returning a NEW array (the parts spliced in at the component's index).
 * Returns null — caller leaves the list as-is — when the component isn't found,
 * has no kit, or a part can't be priced.
 */
export function explodeComponentInList(
  components: ReadonlyArray<LineComponent> | null | undefined,
  componentId: string,
  resolve: PartResolver,
  newId: IdFactory,
): LineComponent[] | null {
  const list = components || [];
  const idx = list.findIndex((c) => c?.id === componentId);
  if (idx < 0) return null;
  const kit = kitForReference(list[idx]?.reference);
  if (!kit) return null;
  const parts = buildPartComponents(list[idx], kit, resolve, newId);
  if (!parts) return null;
  return [...list.slice(0, idx), ...parts, ...list.slice(idx + 1)];
}

/**
 * Recompose a kit group back into one complete-element component, returning a
 * NEW array (the complete piece at the first member's slot, the rest removed).
 * Returns null when the group has no members or the complete SKU can't be
 * priced. Tolerates a non-contiguous group (after a reorder) — it re-unifies.
 */
export function recomposeKitGroupInList(
  components: ReadonlyArray<LineComponent> | null | undefined,
  kitGroup: string,
  resolve: PartResolver,
  newId: IdFactory,
): LineComponent[] | null {
  const list = components || [];
  const memberIdx = new Set<number>();
  list.forEach((c, i) => {
    if (c?.kitGroup === kitGroup) memberIdx.add(i);
  });
  if (memberIdx.size === 0) return null;
  const members = [...memberIdx].sort((a, b) => a - b).map((i) => list[i]);
  const complete = buildCompleteComponent(members, resolve, newId);
  if (!complete) return null;
  const firstIdx = Math.min(...memberIdx);
  const out: LineComponent[] = [];
  list.forEach((c, i) => {
    if (i === firstIdx) out.push(complete);
    if (!memberIdx.has(i)) out.push(c);
  });
  return out;
}
