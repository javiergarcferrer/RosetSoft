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

import { isPricedLine, isPricedComponent, LINE_KIND_SECTION } from './constants.js';
import type {
  QuoteLine,
  LineComponent,
  PricingLine,
  PricingQuote,
  Totals,
  MaterialOptions,
} from '../types/domain.ts';
import { productForGrade } from './catalog.js';
import type { CatalogFamily } from './catalog.ts';

export const ITBIS_PCT = 18;

export interface MaterialOptionDelta {
  grade: string;
  label: string;
  code?: string | null;
  swatchImageId?: string | null;
  /** USD list-price difference vs. the base material (can be negative). */
  delta: number;
}

/**
 * Price deltas for a line/component's material options vs. its base material.
 * Pure: the caller resolves the `CatalogFamily` (groupFamilies over the model's
 * SKUs, keyed by the line's reference root). Deltas are list-price USD
 * differences from the base grade; an option whose grade isn't in the family
 * yields 0 so a stale/missing SKU degrades gracefully (label shows, no number).
 * Returned values are USD — the display layer converts via the line's rates.
 */
export function materialOptionDeltas(
  mo: MaterialOptions | null | undefined,
  family: CatalogFamily | null | undefined,
): MaterialOptionDelta[] {
  if (!mo || !mo.options || !mo.options.length) return [];
  const priceOf = (grade: string): number => safeNum(family ? productForGrade(family, grade)?.priceUsd : 0);
  const base = priceOf(mo.baseGrade);
  return mo.options.map((o) => ({
    grade: o.grade,
    label: o.label,
    code: o.code ?? null,
    swatchImageId: o.swatchImageId ?? null,
    delta: priceOf(o.grade) - base,
  }));
}

/** Coerce to a finite number, falling back to a default if not. */
function safeNum(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Clamp a percentage to [0, max] (default 100). Used for discount fields
 * where a negative value would invert the operation and a >100% value is
 * never meaningful. Exported so input widgets can mirror the clamp.
 */
export function clampPct(v: unknown, max = 100): number {
  const n = safeNum(v, 0);
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}

/* --------------------------- company (house) account --------------------------- */

/**
 * The configured COMPANY account id — the dealer's own customer
 * (`settings.storeCustomerId`), whose quotes are internal store-stock orders.
 * Null ⇒ no company account configured. (Same customer that stocks the public
 * storefront; the storefront shows RETAIL, the dealer's quote views show cost.)
 */
export function companyAccountId(
  settings: { storeCustomerId?: string | null } | null | undefined,
): string | null {
  return settings?.storeCustomerId || null;
}

/** True when `quote` belongs to the configured company account. */
export function isCompanyAccountQuote(
  quote: { customerId?: string | null } | null | undefined,
  settings: { storeCustomerId?: string | null } | null | undefined,
): boolean {
  const acct = companyAccountId(settings);
  return !!acct && !!quote && quote.customerId === acct;
}

/**
 * The cost discount % to apply to `quote`'s product prices: the configured
 * `companyDiscountPct` (clamped 0–100) when the quote is a company-account
 * quote, else 0. The single gate every surface routes through so the dealer's
 * cost view can't drift from the company-account rule.
 */
export function companyDiscountPctFor(
  quote: { customerId?: string | null } | null | undefined,
  settings: { storeCustomerId?: string | null; companyDiscountPct?: number } | null | undefined,
): number {
  if (!isCompanyAccountQuote(quote, settings)) return 0;
  return clampPct(settings?.companyDiscountPct);
}

/**
 * Apply a company-account cost discount to a set of quote lines — scale EVERY
 * base price (the line's `unitPrice`/`priceMin`/`priceMax` and each component's)
 * by (1 − pct/100), returning fresh line objects. Because every pricing
 * primitive derives from these base prices, scaling them is enough to discount
 * unit, subtotal, ranges, compounds, modules and the grand total uniformly —
 * one transform, zero changes to the math. Pure: never mutates the input; pct 0
 * returns a shallow copy untouched. Display/totals only — the STORED line, the
 * public storefront and accounting always keep the list price.
 */
export function applyCompanyDiscount(
  lines: readonly QuoteLine[] | null | undefined,
  pct: unknown,
): QuoteLine[] {
  const arr = (lines || []) as QuoteLine[];
  const p = clampPct(pct);
  if (!p) return arr.slice();
  const f = 1 - p / 100;
  const scale = (v: unknown): number => safeNum(v) * f;
  const scaleComponent = (c: LineComponent): LineComponent => {
    const out: LineComponent = { ...c, unitPrice: scale(c.unitPrice) };
    if (c.priceMin != null) out.priceMin = scale(c.priceMin);
    if (c.priceMax != null) out.priceMax = scale(c.priceMax);
    return out;
  };
  return arr.map((l) => {
    if (!l) return l;
    const out: QuoteLine = { ...l };
    if (l.unitPrice != null) out.unitPrice = scale(l.unitPrice);
    if (l.priceMin != null) out.priceMin = scale(l.priceMin);
    if (l.priceMax != null) out.priceMax = scale(l.priceMax);
    if (Array.isArray(l.components) && l.components.length) {
      out.components = l.components.map(scaleComponent);
    }
    return out;
  });
}

/**
 * The effective company-account cost discount FOR ONE LINE. The company (house)
 * account reads at DEALER COST, and each catalog line froze its real wholesale
 * `unitCost` when added — so a product's cost is ITS OWN cost: the per-SKU margin
 * the Catálogo shows (1 − cost/list), NOT a single flat number. This returns that
 * per-product percent when the line carries a usable cost, and the flat
 * `fallbackPct` otherwise — a hand-typed line (no cost), a material-less RANGE
 * (only the low grade's cost is known) or a COMPOUND (its components don't
 * snapshot a cost). Returns 0 when `fallbackPct` is 0 (a normal quote / the
 * employee view) so a non-company surface is never discounted. Pure.
 */
export function companyLineDiscountPct(
  line: Pick<QuoteLine, 'unitPrice' | 'unitCost' | 'priceMin' | 'priceMax' | 'components'> | null | undefined,
  fallbackPct: unknown,
): number {
  const fb = clampPct(fallbackPct);
  if (fb <= 0) return 0;
  const isCompound = Array.isArray(line?.components) && line!.components!.length > 0;
  const isRange = line?.priceMin != null || line?.priceMax != null;
  const cost = safeNum(line?.unitCost, NaN);
  const list = safeNum(line?.unitPrice, NaN);
  if (!isCompound && !isRange && Number.isFinite(cost) && cost > 0 && Number.isFinite(list) && list > 0) {
    // A product priced below cost would be a negative discount; clamp to [0,100]
    // (reads as "no margin", never a price-up).
    return clampPct((1 - cost / list) * 100);
  }
  return fb;
}

/**
 * Company (house) account COST view, PER PRODUCT — price each line at its OWN
 * cost (companyLineDiscountPct), reusing applyCompanyDiscount one line at a time
 * so the compound / range / fallback branches behave exactly as the flat version
 * did. Returns fresh objects; never mutates. Display/totals only — the STORED
 * line keeps the list price. The per-product twin of applyCompanyDiscount.
 */
export function applyCompanyCost(
  lines: readonly QuoteLine[] | null | undefined,
  fallbackPct: unknown,
): QuoteLine[] {
  return (lines || []).map((l) =>
    (l ? applyCompanyDiscount([l], companyLineDiscountPct(l, fallbackPct))[0] : l),
  );
}

/**
 * Settings as a given VIEWER may see the company-account COST. The dealer's
 * permanent cost discount (`companyDiscountPct`) is admin-only — an employee
 * gets it zeroed so company-account surfaces read at LIST price for them. The
 * company-account IDENTITY (`storeCustomerId`) is preserved either way, so the
 * ITBIS exemption (a company quote is never taxed) still applies for everyone.
 * Pure: the same object for an admin, a shallow clone with the discount off
 * otherwise. The single role gate every dealer surface routes settings through.
 */
export function viewerCompanySettings(
  settings: { storeCustomerId?: string | null; companyDiscountPct?: number } | null | undefined,
  canSeeCost: boolean,
) {
  if (canSeeCost) return settings;
  return { ...(settings || {}), companyDiscountPct: 0 };
}

/**
 * Compute totals for a quote.
 *
 * Order of operations matters when both margin and discount are non-zero:
 *
 *   lineUnit      = applyLineAdjustments(basePrice, lineMarginPct, lineDiscountPct)
 *   subtotal      = Σ( lineUnit × qty )
 *   afterMargin   = subtotal × (1 + marginPct/100)            // margin lifts the bill
 *   afterDiscount = afterMargin × (1 − discountPct/100)       // discount eats into the lifted total
 *   afterCourtesy = afterDiscount × (1 − courtesyDiscountPct/100)  // friends & family, on top
 *   taxAmt        = afterCourtesy × (ITBIS/100)
 *   grandTotal    = afterCourtesy + taxAmt + shipping
 *
 * The TWO discounts are independent and stack, but settle DIFFERENTLY against
 * the professional's commission (see lib/commissions:commissionBreakdown):
 *   - `discountPct` is drawn out of the commission dollar-for-dollar.
 *   - `courtesyDiscountPct` (Friends & Family) is NOT drawn out; it just lowers
 *     `taxableBase`, so the commission is the same % on the post-courtesy base
 *     (a proportional reduction). It shows as its own line on the client's bill.
 *
 * Constraints (defense in depth — inputs are also clamped at the UI layer):
 *   - marginPct:           free range (negative = loss-leader / clearance is legitimate)
 *   - discountPct:         clamped to [0, 100]
 *   - courtesyDiscountPct: clamped to [0, 100]
 *   - line pcts:           same rules as quote-level pcts
 *   - shipping:            clamped to [0, ∞)
 *   - non-finite numeric inputs are treated as 0 (never NaN-out a quote)
 *
 * @param {Array} lines  resolved line items: { qty, basePrice, lineMarginPct, lineDiscountPct }
 * @param {Object} quote { marginPct, discountPct, courtesyDiscountPct, shipping }
 *                       (taxPct is intentionally ignored — ITBIS is fixed)
 * @returns {Object} { subtotal, marginAmt, discountAmt, courtesyDiscountAmt, taxableBase, taxAmt, shipping, grandTotal, taxPct }
 */
export function computeTotals(
  lines: readonly PricingLine[] | null | undefined,
  quote: PricingQuote = {},
  opts: { taxExempt?: boolean } = {},
): Totals {
  const subtotal = (lines || []).reduce((acc, l) => {
    const unit = applyLineAdjustments(l?.basePrice, l?.lineMarginPct, l?.lineDiscountPct);
    return acc + unit * safeNum(l?.qty, 0);
  }, 0);

  const marginPct = safeNum(quote.marginPct, 0);
  const discountPct = clampPct(quote.discountPct);
  const courtesyPct = clampPct(quote.courtesyDiscountPct);

  const marginAmt = subtotal * (marginPct / 100);
  const afterMargin = subtotal + marginAmt;
  const discountAmt = afterMargin * (discountPct / 100);
  const afterDiscount = afterMargin - discountAmt;
  const courtesyDiscountAmt = afterDiscount * (courtesyPct / 100);
  const taxableBase = afterDiscount - courtesyDiscountAmt;
  // A company-account quote is an internal cost / order document, not a taxable
  // customer sale → ITBIS is suppressed (opts.taxExempt). Every other quote
  // taxes the post-courtesy base at the fixed ITBIS rate.
  const taxExempt = !!opts.taxExempt;
  const taxAmt = taxExempt ? 0 : taxableBase * (ITBIS_PCT / 100);
  const shipping = Math.max(0, safeNum(quote.shipping, 0));
  const grandTotal = taxableBase + taxAmt + shipping;

  return {
    subtotal: safeNum(subtotal),
    marginAmt: safeNum(marginAmt),
    discountAmt: safeNum(discountAmt),
    courtesyDiscountAmt: safeNum(courtesyDiscountAmt),
    taxableBase: safeNum(taxableBase),
    taxAmt: safeNum(taxAmt),
    shipping,
    grandTotal: safeNum(grandTotal),
    taxPct: taxExempt ? 0 : ITBIS_PCT,
  };
}

export function applyLineAdjustments(
  basePrice: unknown,
  marginPct: unknown,
  discountPct: unknown,
): number {
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
export function isCompoundLine(
  line: Pick<QuoteLine, 'components'> | null | undefined,
): line is Pick<QuoteLine, 'components'> & { components: LineComponent[] } {
  return Array.isArray(line?.components) && line!.components!.length > 0;
}

export function componentSubtotal(component: LineComponent | null | undefined): number {
  return safeNum(component?.unitPrice, 0) * safeNum(component?.qty, 0);
}

export function compoundSubtotal(line: QuoteLine | null | undefined): number {
  if (!isCompoundLine(line)) return 0;
  // Only PRICED components roll up into the compound's billable subtotal: an
  // excluded optional, or a non-selected component alternative, still renders to
  // the customer but doesn't count — the component twin of isPricedLine
  // (lib/constants:isPricedComponent). A plain component (no flags) always
  // counts, so prior behaviour is unchanged.
  return line.components
    .filter((c) => isPricedComponent(c))
    .reduce((sum, c) => sum + componentSubtotal(c), 0);
}

/**
 * Per-unit base price for a line. For a normal line this is unitPrice;
 * for a compound it's the sum of component subtotals (with qty=1, since
 * the components carry their own quantities).
 */
export function lineBasePrice(line: QuoteLine | null | undefined): number {
  if (isCompoundLine(line)) return compoundSubtotal(line);
  return safeNum(line?.unitPrice, 0);
}

/** Effective quantity multiplier for a line — always 1 for compounds. */
export function lineQty(line: QuoteLine | null | undefined): number {
  if (isCompoundLine(line)) return 1;
  return safeNum(line?.qty, 0);
}

/** Final per-line total, after line-level margin and discount. */
export function lineTotal(line: QuoteLine | null | undefined): number {
  const base = lineBasePrice(line);
  return applyLineAdjustments(base, line?.lineMarginPct, line?.lineDiscountPct) * lineQty(line);
}

/**
 * Map a raw quote line (item or compound) onto the shape `computeTotals`
 * expects. Centralizes the compound-vs-normal branch so call sites
 * (QuoteBuilder, Dashboard, ProfessionalDetail, Commissions, ClientPreview)
 * don't each have to redo the math.
 */
export function lineForTotals(line: QuoteLine | null | undefined): PricingLine {
  return {
    qty: lineQty(line),
    basePrice: lineBasePrice(line),
    lineMarginPct: line?.lineMarginPct,
    lineDiscountPct: line?.lineDiscountPct,
  };
}

/**
 * Per-line "list price" — what each unit would cost WITHOUT the
 * line-level discount. Used by the customer-facing renderers (PDF +
 * ClientPreview) to surface the saving with a strike-through next to
 * the discounted unit. Includes line-level margin (the catalogue
 * price the customer would otherwise have paid) but excludes the
 * line-level discount.
 */
export function lineListUnit(line: QuoteLine | null | undefined): number {
  const base = lineBasePrice(line);
  const margin = safeNum(line?.lineMarginPct, 0);
  return base * (1 + margin / 100);
}

/* ------------------------------ sections ------------------------------ */

/**
 * Subtotal of a SECTION — the sum of the priced lines that fall under one
 * section header (the items between this divider and the next).
 *
 * "Priced" uses the SAME `isPricedLine` predicate the grand total does, so the
 * figure can never diverge from `computeTotals`' `subtotal`: section dividers,
 * optionals and non-selected alternatives drop out; set members and the chosen
 * alternative are summed at their own `lineTotal`. It's a pre-quote-discount,
 * pre-tax roll-up of the products shown in the section — so the section
 * subtotals add up to the Subtotal row. Returns 0 for an empty section.
 *
 * @param items  the line items under one section header (NOT the section row
 *               itself). Callers slice the flat list by section boundary.
 */
export function sectionSubtotal(
  items: readonly QuoteLine[] | null | undefined,
): number {
  return (items || [])
    .filter((l) => isPricedLine(l))
    .reduce((sum, l) => sum + lineTotal(l), 0);
}

/* ------------------------------ conjuntos (sets) ------------------------------ */

/**
 * "Total del conjunto" — the rolled-up total of a Conjunto (set).
 *
 * A Conjunto is a TAKE-ALL group: distinct standalone products sold
 * together (see QuoteLine.setGroup). Every member is priced normally,
 * so the set's total is the simple SUM of each member's own
 * `lineTotal` (margin + discount + qty already baked in per member).
 * There is NO separate set price and NO set-level discount — this is
 * sum-only.
 *
 * @param {Array}  lines     all quote lines (the full list — this filters)
 * @param {string} setGroup  the set's group id
 * @returns {number} Σ lineTotal(member) over lines with that setGroup.
 *                   Returns 0 for a falsy setGroup or no members.
 */
export function setSubtotal(
  lines: readonly QuoteLine[] | null | undefined,
  setGroup: string | null | undefined,
): number {
  if (!setGroup) return 0;
  return (lines || [])
    .filter((l) => l?.setGroup === setGroup)
    .reduce((sum, l) => sum + lineTotal(l), 0);
}

/**
 * Set subtotal RANGE — Σ of every member's total range (take-all). Collapses to
 * a point (min === max) when no member is material-less, so a set footer only
 * widens to "min – max" when a piece genuinely carries a range (a range line,
 * or a compound with a range component).
 */
export function setSubtotalRange(
  lines: readonly QuoteLine[] | null | undefined,
  setGroup: string | null | undefined,
): MoneyRange {
  if (!setGroup) return { min: 0, max: 0 };
  return (lines || [])
    .filter((l) => l?.setGroup === setGroup)
    .reduce(
      (acc, l) => {
        const r = lineTotalRange(l);
        return { min: acc.min + r.min, max: acc.max + r.max };
      },
      { min: 0, max: 0 },
    );
}

/**
 * Per-line "N de M" position info for a grouping key, keyed by line id.
 *
 * The shared engine behind setGroupInfo / alternativeGroupInfo: position is
 * the line's 1-based order within its group as it appears in `lines`; total
 * is the group size. Lines whose `keyOf` yields a falsy id are absent from
 * the map. `{ index, total }` is the same shape every caption consumes.
 */
function groupPositionInfo(
  lines: readonly QuoteLine[] | null | undefined,
  keyOf: (line: QuoteLine) => string | null | undefined,
): Map<string, { index: number; total: number }> {
  const map = new Map<string, { index: number; total: number }>();
  const counts = new Map<string, number>();
  for (const l of lines || []) {
    const g = l ? keyOf(l) : null;
    if (!g) continue;
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const l of lines || []) {
    const g = l ? keyOf(l) : null;
    if (!g) continue;
    const idx = (seen.get(g) || 0) + 1;
    seen.set(g, idx);
    map.set(l.id, { index: idx, total: counts.get(g) as number });
  }
  return map;
}

/**
 * Per-line "Conjunto N de M" position info, keyed by line id.
 *
 * So set members can show a quiet "Conjunto N de M" eyebrow. Position is the
 * line's 1-based order within its set as it appears in `lines`; total is the
 * set size. Lines with no `setGroup` are absent from the map. The preview /
 * PDF renderers call this once per render and look up each line by id.
 *
 * @param {Array} lines  all quote lines
 * @returns {Map<string, { index: number, total: number }>}
 */
export function setGroupInfo(
  lines: readonly QuoteLine[] | null | undefined,
): Map<string, { index: number; total: number }> {
  return groupPositionInfo(lines, (l) => l.setGroup);
}

/**
 * Per-line "Alternativa N de M" position info, keyed by line id — the
 * alternative-group twin of setGroupInfo. Single source of truth shared by
 * the editor (LineItemList) and the customer surfaces (ClientPreview / PDF)
 * so the caption reads identically everywhere instead of each surface
 * hand-rolling the same scan. Lines with no `alternativeGroup` are absent.
 *
 * @param {Array} lines  all quote lines
 * @returns {Map<string, { index: number, total: number }>}
 */
export function alternativeGroupInfo(
  lines: readonly QuoteLine[] | null | undefined,
): Map<string, { index: number; total: number }> {
  return groupPositionInfo(lines, (l) => l.alternativeGroup);
}

/* --------------------------- alternativas (alternatives) --------------------------- */

/**
 * The SELECTED member of an alternative group — the one line that counts
 * toward the quote total and whose price the group's footer shows.
 *
 * Within a well-formed group exactly one member carries
 * `isSelectedAlternative`; this returns that line. As a defensive
 * fallback (a group momentarily left with 0 selected after an edit) it
 * returns the FIRST member of the group as it appears in `lines`, so a
 * footer / total never reads as empty. Returns null for a falsy group
 * id or when the group has no members.
 *
 * @param lines    all quote lines (the full list — this filters)
 * @param groupId  the alternative group's id
 */
export function selectedAlternative(
  lines: readonly QuoteLine[] | null | undefined,
  groupId: string | null | undefined,
): QuoteLine | null {
  if (!groupId) return null;
  const members = (lines || []).filter((l) => l?.alternativeGroup === groupId);
  if (members.length === 0) return null;
  return members.find((l) => l?.isSelectedAlternative) || members[0];
}

/**
 * "Total" of an alternative group — the SELECTED member's own line total.
 *
 * Unlike a Conjunto (sum of ALL members), an alternative group bills only
 * the one option the customer picks, so its footer/total equals
 * `lineTotal(selectedAlternative(...))`. Returns 0 for a falsy group id or
 * an empty group.
 *
 * @param lines    all quote lines (the full list — this filters)
 * @param groupId  the alternative group's id
 */
export function alternativeSubtotal(
  lines: readonly QuoteLine[] | null | undefined,
  groupId: string | null | undefined,
): number {
  const sel = selectedAlternative(lines, groupId);
  return sel ? lineTotal(sel) : 0;
}

/* ------------------------------ group runs (sets + alternatives) ------------------------------ */

/**
 * A contiguous "run" of adjacent lines sharing the same grouping key —
 * either a Conjunto (`setGroup`) or an Alternativa (`alternativeGroup`).
 *
 *   type    'set' | 'alternative' for grouped runs; 'single' for a lone
 *           ungrouped line (or a section) that isn't part of any run.
 *   groupId the shared setGroup / alternativeGroup string ('single' → null).
 *   lineIds the member line ids, in list order.
 *   start   index in `lines` of the run's first member.
 */
export interface GroupRun {
  type: 'set' | 'alternative' | 'single';
  groupId: string | null;
  lineIds: string[];
  start: number;
}

/**
 * Partition an ordered line list into contiguous group RUNS — the single
 * source of truth for "where does each group card start and end" shared
 * by the editor (LineItemList) and the customer surfaces (ClientPreview /
 * PDF). A run is a maximal stretch of ADJACENT lines carrying the same
 * `setGroup` (a set run) or the same `alternativeGroup` (an alternative
 * run); every other line — ungrouped items AND section dividers — is its
 * own one-element 'single' run.
 *
 * Because runs are detected by adjacency, a reorder that splits a group
 * simply yields two separate runs of the same groupId — the renderer
 * reflects the new contiguous reality without any group-level bookkeeping.
 * A line is never simultaneously in a set and an alternative (the type's
 * exclusivity rule + a DB CHECK guarantee it), so the two keys never
 * compete for the same run.
 *
 * @param lines  ordered quote lines
 * @returns the runs, in list order; concatenating their lineIds
 *          reproduces the input order.
 */
export function groupRuns(
  lines: readonly QuoteLine[] | null | undefined,
): GroupRun[] {
  const runs: GroupRun[] = [];
  const arr = lines || [];
  for (let i = 0; i < arr.length; i++) {
    const l = arr[i];
    const setG = l?.setGroup || null;
    const altG = l?.alternativeGroup || null;
    const key = setG || altG;
    const prev = runs[runs.length - 1];
    if (key && prev && prev.groupId === key && (
      (setG && prev.type === 'set') || (altG && prev.type === 'alternative')
    )) {
      prev.lineIds.push(l.id);
      continue;
    }
    runs.push({
      type: setG ? 'set' : altG ? 'alternative' : 'single',
      groupId: key,
      lineIds: [l.id],
      start: i,
    });
  }
  return runs;
}

/* ------------------------------ price ranges (material-less lines) ------------------------------ */

export interface MoneyRange { min: number; max: number; }

/**
 * A line quoted WITHOUT a chosen material carries a PRICE RANGE — the model's
 * cheapest→priciest fabric grade, snapshotted onto the line as priceMin /
 * priceMax when it's added (so totals AND the PDF stay pure, with no live
 * catalog lookup — the public share link has no catalog at all). A normal,
 * fully-specified line has neither set and prices at its single unitPrice.
 * Picking a material on the line clears the range and pins a concrete price.
 */
/** A section header + the lines beneath it. Items before any section live
 *  under a null-label group. */
export interface LineSectionGroup { label: string | null; items: QuoteLine[]; }

/**
 * Group lines under their preceding section header — the shared section
 * projection the client preview AND the PDF both lay out, so a section reads
 * the same on screen and on paper.
 */
export function groupBySection(
  lines: readonly QuoteLine[] | null | undefined,
): LineSectionGroup[] {
  const groups: LineSectionGroup[] = [];
  let cur: LineSectionGroup = { label: null, items: [] };
  for (const l of lines || []) {
    if (l?.kind === LINE_KIND_SECTION) {
      if (cur.items.length || cur.label) groups.push(cur);
      cur = { label: l.name || 'Sección', items: [] };
    } else if (l) {
      cur.items.push(l);
    }
  }
  if (cur.items.length || cur.label) groups.push(cur);
  return groups;
}

export function isRangeLine(line: QuoteLine | null | undefined): boolean {
  if (!line || isCompoundLine(line)) return false;
  const min = line.priceMin;
  const max = line.priceMax;
  return min != null && max != null && safeNum(max) > safeNum(min);
}

/**
 * A COMPONENT quoted without a chosen material carries a price range — the
 * mirror of isRangeLine, one level down. Drives the compound's range so a
 * compound made of material-less pieces widens just like a standalone line.
 */
export function isRangeComponent(component: LineComponent | null | undefined): boolean {
  if (!component) return false;
  const min = component.priceMin;
  const max = component.priceMax;
  return min != null && max != null && safeNum(max) > safeNum(min);
}

/** Component subtotal RANGE — qty on both ends; a point for a fixed component. */
export function componentSubtotalRange(component: LineComponent | null | undefined): MoneyRange {
  if (!isRangeComponent(component)) {
    const t = componentSubtotal(component);
    return { min: t, max: t };
  }
  const qty = safeNum(component!.qty, 0);
  return { min: safeNum(component!.priceMin) * qty, max: safeNum(component!.priceMax) * qty };
}

/** Compound subtotal RANGE — sum of the non-optional components' subtotal ranges. */
export function compoundSubtotalRange(line: QuoteLine | null | undefined): MoneyRange {
  if (!isCompoundLine(line)) return { min: 0, max: 0 };
  return line.components
    .filter((c) => isPricedComponent(c))
    .reduce(
      (acc, c) => {
        const r = componentSubtotalRange(c);
        return { min: acc.min + r.min, max: acc.max + r.max };
      },
      { min: 0, max: 0 },
    );
}

/** "Opción N de M" position map for a compound's component alternatives, keyed
 *  by component id (the component twin of alternativeGroupInfo). */
export function componentAlternativeGroupInfo(
  components: readonly LineComponent[] | null | undefined,
): Map<string, { index: number; total: number }> {
  const map = new Map<string, { index: number; total: number }>();
  const counts = new Map<string, number>();
  for (const c of components || []) {
    const g = c?.alternativeGroup;
    if (g) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const c of components || []) {
    const g = c?.alternativeGroup;
    if (!g || !c?.id) continue;
    const idx = (seen.get(g) || 0) + 1;
    seen.set(g, idx);
    map.set(c.id, { index: idx, total: counts.get(g) as number });
  }
  return map;
}

/** The selected member of a component alternative group (first as a fallback). */
export function selectedAlternativeComponent(
  components: readonly LineComponent[] | null | undefined,
  groupId: string | null | undefined,
): LineComponent | null {
  if (!groupId) return null;
  const members = (components || []).filter((c) => c?.alternativeGroup === groupId);
  if (members.length === 0) return null;
  return members.find((c) => c?.isSelectedAlternative) || members[0];
}

/**
 * True when a line shows a price range — a compound with at least one
 * material-less (range) component, OR a standalone range item. The compound-
 * aware predicate the UI uses to decide between "min – max" and a single total.
 */
export function lineHasRange(line: QuoteLine | null | undefined): boolean {
  if (isCompoundLine(line)) {
    return (line!.components || []).some((c) => isPricedComponent(c) && isRangeComponent(c));
  }
  return isRangeLine(line);
}

/**
 * Per-line TOTAL range — line-level margin/discount + qty applied to BOTH the
 * low and high ends. Collapses to a point (min === max === lineTotal) for a
 * normal single-price line, so range-aware callers never special-case.
 */
export function lineTotalRange(line: QuoteLine | null | undefined): MoneyRange {
  // Compound: sum the component ranges, then apply the line-level margin /
  // discount to each end (a compound's qty is always 1). Collapses to a point
  // (= lineTotal) when no component carries a range, so existing behaviour is
  // unchanged for a fully-specified compound.
  if (isCompoundLine(line)) {
    const r = compoundSubtotalRange(line);
    const adj = (base: number): number =>
      applyLineAdjustments(base, line?.lineMarginPct, line?.lineDiscountPct);
    return { min: adj(r.min), max: adj(r.max) };
  }
  if (!isRangeLine(line)) {
    const t = lineTotal(line);
    return { min: t, max: t };
  }
  const qty = lineQty(line);
  const adj = (base: number): number =>
    applyLineAdjustments(base, line?.lineMarginPct, line?.lineDiscountPct) * qty;
  return { min: adj(safeNum(line!.priceMin)), max: adj(safeNum(line!.priceMax)) };
}

/** True when any line that counts toward the total carries a price range
 *  (compound-aware — a compound with a material-less component counts). */
export function quoteHasRange(lines: readonly QuoteLine[] | null | undefined): boolean {
  return (lines || []).some((l) => isPricedLine(l) && lineHasRange(l));
}

/**
 * Grand-total RANGE — the SAME pipeline `computeTotals` runs (margin → discount
 * → ITBIS → shipping), applied to the low and high ends of every priced line's
 * total. Takes RAW quote lines and filters with the same `isPricedLine` rule
 * the scalar total does (so optionals + non-selected alternatives drop out and
 * the two figures can never diverge). Collapses to a point (min === max) when
 * nothing carries a range, so a fully-specified quote shows one number.
 */
export function computeTotalsRange(
  lines: readonly QuoteLine[] | null | undefined,
  quote: PricingQuote = {},
  opts: { taxExempt?: boolean } = {},
): MoneyRange {
  let subMin = 0;
  let subMax = 0;
  for (const l of lines || []) {
    if (!isPricedLine(l)) continue;
    const r = lineTotalRange(l);
    subMin += r.min;
    subMax += r.max;
  }
  const marginPct = safeNum(quote.marginPct, 0);
  const discountPct = clampPct(quote.discountPct);
  const courtesyPct = clampPct(quote.courtesyDiscountPct);
  const shipping = Math.max(0, safeNum(quote.shipping, 0));
  const taxExempt = !!opts.taxExempt;
  const grand = (subtotal: number): number => {
    const afterMargin = subtotal * (1 + marginPct / 100);
    const afterDiscount = afterMargin * (1 - discountPct / 100);
    const taxable = afterDiscount * (1 - courtesyPct / 100);
    const tax = taxExempt ? 0 : taxable * (ITBIS_PCT / 100);
    return taxable + tax + shipping;
  };
  return { min: safeNum(grand(subMin)), max: safeNum(grand(subMax)) };
}

