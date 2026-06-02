/**
 * Pure mapping: a RosetSoft catalog MODEL → the Shopify product it becomes.
 *
 * This is the heart of the RosetSoft → Shopify integration. It takes the same
 * MODELS the Catálogo page builds (`groupFamilies` collapses an 8-digit SKU
 * root + its grade-variant SKUs into one family) and projects each into the
 * flat product shape the sync script sends to the Shopify Admin API.
 *
 * Decisions baked in here (so the script stays thin I/O):
 *   - One Shopify PRODUCT per model; each fabric grade becomes a VARIANT under
 *     a single "Grado" option, priced at that grade's list price. An ungraded
 *     model (table, lamp, wood chair) becomes a single-variant product.
 *   - `handle` is derived ONLY from the model root, so re-running the sync
 *     upserts in place (idempotent) instead of spawning duplicates.
 *   - Money is emitted as a Shopify-style decimal string ("1234.00").
 *   - Status defaults to DRAFT — nothing a sync creates is ever live until the
 *     dealer publishes it in Shopify.
 *
 * Pure: no Shopify SDK, no network, no `db`. Reuses the catalog primitives so a
 * model maps the same way it's grouped/priced everywhere else. Unit-tested by
 * tests/shopifyCatalog.test.js; the script (scripts/shopify/syncCatalog.ts) is
 * the only thing that does I/O.
 */
import type { Product } from '../types/domain';
import { groupFamilies, productForGrade, type CatalogFamily } from './catalog.js';

/** One Shopify variant — a single fabric grade (or the lone variant of an
 *  ungraded model). `grade` is the option value ("A", "G", …) or null. */
export interface ShopifyVariantInput {
  sku: string;
  /** Shopify decimal money string, e.g. "1234.00". */
  price: string;
  grade: string | null;
}

/** The flat product shape the sync script hands to the Admin API. Maps cleanly
 *  onto a `productSet` ProductSetInput (handle identity → idempotent upsert). */
export interface ShopifyProductInput {
  /** Stable, derived from the model root — the idempotent upsert key. */
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: 'DRAFT' | 'ACTIVE';
  /** "Grado" for a fabric-graded model, null for a single-variant product. */
  optionName: string | null;
  variants: ShopifyVariantInput[];
  /** USD list-price span across the included variants (for "desde $…"). */
  priceMin: number;
  priceMax: number;
}

export interface MapOptions {
  /** Shopify vendor. Defaults to "Ligne Roset". */
  vendor?: string;
  /** Initial status. Defaults to "DRAFT" (safe: never auto-live). */
  status?: 'DRAFT' | 'ACTIVE';
  /** Extra tags to stamp on every product (e.g. "lookbook"). */
  extraTags?: string[];
}

const DEFAULT_VENDOR = 'Ligne Roset';

function money(n: unknown): string {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toFixed(2);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Stable Shopify handle for a model — root only, so a re-sync updates in place.
 *  Lower-cased, non-alphanumerics folded to single hyphens. */
export function modelHandle(root: string): string {
  const slug = String(root || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `lr-${slug || 'item'}`;
}

/** The representative product of a model — used for category/dimensions/name. */
function repProduct(family: CatalogFamily): Product | null {
  if (family.graded && family.grades.length) {
    return productForGrade(family, family.grades[0]);
  }
  for (const p of family.byGrade.values()) return p;
  return null;
}

function dedupeTags(tags: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const v = String(t || '').trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/**
 * Project ONE catalog model into its Shopify product. Returns null when the
 * model carries no priced variant (nothing sellable to publish).
 */
export function toShopifyProduct(
  family: CatalogFamily,
  opts: MapOptions = {},
): ShopifyProductInput | null {
  const rep = repProduct(family);
  const category = (rep?.category || '').trim();
  const collection = (family.family || rep?.family || '').trim();

  // Build the variants — one per priced grade, or the lone ungraded SKU.
  const variants: ShopifyVariantInput[] = [];
  if (family.graded) {
    for (const grade of family.grades) {
      const p = family.byGrade.get(grade);
      const price = Number(p?.priceUsd) || 0;
      if (!p?.reference || price <= 0) continue;
      variants.push({ sku: p.reference, price: money(price), grade });
    }
  } else {
    const p = rep;
    const price = Number(p?.priceUsd) || 0;
    if (p?.reference && price > 0) {
      variants.push({ sku: p.reference, price: money(price), grade: null });
    }
  }
  if (variants.length === 0) return null;

  const graded = variants.some((v) => v.grade != null) && variants.length > 1;
  const prices = variants.map((v) => Number(v.price));

  // A tasteful, minimal description — collection, the rep's dimensions, and the
  // catalog reference. No cost/margin ever (this is a public storefront).
  const lines: string[] = [];
  if (collection) lines.push(`<p>${escapeHtml(collection)}</p>`);
  const dims = (rep?.dimensions || '').trim();
  if (dims) lines.push(`<p>${escapeHtml(dims)}</p>`);
  lines.push(`<p>${escapeHtml(DEFAULT_VENDOR)} · Ref. ${escapeHtml(family.root)}</p>`);

  return {
    handle: modelHandle(family.root),
    title: (family.name || collection || family.root).trim(),
    descriptionHtml: lines.join('\n'),
    vendor: opts.vendor || DEFAULT_VENDOR,
    productType: category,
    tags: dedupeTags([category, collection, DEFAULT_VENDOR, 'rosetsoft', ...(opts.extraTags || [])]),
    status: opts.status || 'DRAFT',
    optionName: graded ? 'Grado' : null,
    variants,
    priceMin: Math.min(...prices),
    priceMax: Math.max(...prices),
  };
}

/**
 * Group a flat product list into models and project each into its Shopify
 * product, dropping models with nothing priced. The convenience entry the sync
 * script calls after parsing the price-list CSV.
 */
export function catalogToShopifyProducts(
  products: readonly Product[] | null | undefined,
  opts: MapOptions = {},
): ShopifyProductInput[] {
  const out: ShopifyProductInput[] = [];
  for (const family of groupFamilies(products)) {
    const mapped = toShopifyProduct(family, opts);
    if (mapped) out.push(mapped);
  }
  return out;
}
