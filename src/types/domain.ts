/**
 * Central domain types for the Roset Soft app.
 *
 * Every shape here is the CAMEL-CASED, JS-side projection — what the
 * code actually sees AFTER `db/rowMapping.ts:fromRow` converts a
 * Postgres row. The snake_case column names live in the migrations
 * and never escape `db/database.ts`.
 *
 * `*At` fields are JS millisecond timestamps (numbers), not ISO
 * strings — `fromRow` parses on read, `toRow` re-serialises on write.
 *
 * Optionality reflects what the codebase actually sees: a freshly-
 * created draft may carry nulls / undefineds the DB defaults to,
 * because the round-trip is "client write → server default → next
 * read". When in doubt, prefer `field?: T | null` over `field: T` so
 * downstream code has to consciously handle the missing case.
 */

/* ----------------------------- discriminator enums ----------------------------- */

/**
 * `quote_lines.kind`. Compound articles are NOT a separate kind —
 * they're regular items whose `components` array is non-empty
 * (see `isCompoundLine` in lib/pricing).
 */
export type LineKind = 'item' | 'section';

/**
 * `quotes.status` lifecycle.
 * Pinned by CHECK constraint (migration 20260519200000).
 */
export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'archived';

/**
 * How an assigned professional's cut is settled — chosen per quote.
 * Internal/accounting only; never affects the client PDF (the client
 * always sees the full price). See `lib/commissions.ts`.
 *   • 'commission'     — invoice the client, pay the decorator a commission.
 *   • 'trade_discount' — invoice the decorator at their % off; no commission.
 */
export type DecoratorBilling = 'commission' | 'trade_discount';

/**
 * `orders.status` lifecycle — six main stages + cancelled.
 * Pinned by CHECK constraint (migration 20260519200000).
 * Source of truth for labels/timestamps: `lib/orderStages.js`.
 */
export type OrderStatus =
  | 'draft'
  | 'placed'
  | 'confirmed'
  | 'in_transit'
  | 'in_customs'
  | 'received'
  | 'cancelled';

/**
 * `profiles.role`. Determines what UI surfaces the user can see and
 * what RLS lets them do. The 'team' value is reserved for the shared
 * settings row, not a human user.
 */
export type ProfileRole = 'admin' | 'employee' | 'accounting' | 'team';

/**
 * `settings.dop_rate_mode`. Legacy: the app used to let the dealer pick
 * which rate to quote on. The rate is now pulled automatically from
 * Banco Popular and always quoted on venta (see lib/exchangeRate.ts), so
 * nothing reads this field anymore — kept only so old rows still type-check.
 */
export type DopRateMode = 'bsc-buy' | 'bsc-sell' | 'custom';

/** Currency codes the app surfaces. */
export type CurrencyCode = 'USD' | 'DOP';

/** `{ USD: 1, DOP: 60.0, ... }` shape passed to `formatMoney`. */
export type RatesMap = Partial<Record<CurrencyCode, number>> & {
  USD: number;
};

/* --------------------------------- entities --------------------------------- */

export interface Profile {
  id: string;
  name: string;
  email?: string | null;
  role?: ProfileRole;
  active?: boolean;
  /** Seller commission percent on quotes this user creates. 0–50. */
  commissionPct?: number;
  invitedBy?: string | null;
  lastSignInAt?: number | null;
  passwordSetAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Published USD↔DOP rate snapshot (Banco Popular Dominicano), written by
 * the `bpd-rate` Edge Function. `null` means no pull has landed yet.
 */
export interface ExchangeRate {
  buy: number | null;
  sell: number | null;
  updatedAt: number | null;
}

export interface Settings {
  profileId: string;
  companyName?: string;
  companyAddress?: string;
  companyEmail?: string;
  companyPhone?: string;
  logoImageId?: string | null;
  defaultCurrency?: CurrencyCode;
  /**
   * Legacy. The rate's single source of truth is now `exchangeRate` (read
   * via effectiveDopRate); this column is no longer written or read for
   * pricing. Kept so older rows still type-check.
   */
  currencyRates?: RatesMap;
  /** Single source of truth for the USD↔DOP rate (Banco Popular venta). */
  exchangeRate?: ExchangeRate;
  /**
   * Legacy aliases of `exchangeRate` (bsc = Banco Santa Cruz, bpd = Banco
   * Popular Dominicano). Read-only fallbacks for rows not yet migrated.
   */
  bsc?: ExchangeRate;
  bpd?: ExchangeRate;
  dopRateMode?: DopRateMode | string;
  defaultMarginPct?: number;
  defaultDiscountPct?: number;
  quoteTerms?: string;
  quoteFooter?: string;
  /** Lower-cased email allow-list for bootstrap-admin promotion. */
  adminEmails?: string[];
  /** Minimum USD value before an order's first container can dispatch. */
  dispatchThreshold?: number;
}

export interface Customer {
  id: string;
  profileId: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  notes?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface Professional {
  id: string;
  profileId: string;
  number?: number;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  notes?: string;
  /** 0–20. The dealer's house cap. */
  defaultCommissionPct?: number;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * One component inside a compound quote line. Each carries its own
 * spec + pricing; the parent line contributes the shared family +
 * photo + composition name.
 */
export interface LineComponent {
  id: string;
  name?: string;
  reference?: string;
  /** Composed `<grade> · <fabric>` string — same shape as line.subtype. */
  subtype?: string;
  dimensions?: string;
  description?: string;
  qty?: number;
  unitPrice?: number;
  /**
   * When true, the component is shown to the customer as an opt-in
   * add-on but excluded from the compound's subtotal. Mirrors the
   * line-level isOptional flag — see lib/pricing:compoundSubtotal,
   * which skips optional components when summing.
   *
   * Lives on the JSONB component shape (no DB column change needed
   * — components are stored as `quote_lines.components`). Default
   * false on every new component.
   */
  isOptional?: boolean;
  /**
   * Fabric swatch image (by `images.id`) chosen via the SwatchPicker
   * for this component. Distinct from the parent line's imageId
   * (the product photo). Lives inline on the JSONB component shape.
   */
  swatchImageId?: string | null;
}

export interface QuoteLine {
  id: string;
  quoteId: string;
  kind: LineKind;
  sortOrder?: number;

  /* Identity */
  family?: string;
  reference?: string;
  name?: string;
  subtype?: string;
  dimensions?: string;
  description?: string;
  pageRef?: string;
  imageId?: string | null;
  /**
   * Fabric swatch image (by `images.id`) chosen via the SwatchPicker.
   * Distinct from `imageId`, which is the product photo (the sofa).
   * A line can carry both. Renders in the editor's grade/fabric row
   * and in the client preview + PDF next to the subtype.
   */
  swatchImageId?: string | null;

  /* Pricing — ignored when `components` is non-empty (compound mode). */
  qty?: number;
  unitPrice?: number;
  lineMarginPct?: number;
  lineDiscountPct?: number;

  /* Compound article — non-empty array makes this line compound. */
  components?: LineComponent[];

  /* Product options + alternatives.
   *   isOptional               line excluded from the quote total
   *                            until the dealer un-toggles (the
   *                            customer accepted the add-on).
   *   alternativeGroup         id shared by sibling lines the
   *                            customer picks between; null means
   *                            the line is standalone.
   *   isSelectedAlternative    within a group, exactly one line
   *                            has this true and is the one that
   *                            counts toward the total. The others
   *                            still render so the customer sees
   *                            the menu.
   * Pricing math in lib/constants:isPricedLine respects both flags;
   * a DB CHECK constraint forbids the meaningless combination
   * (optional + alternative).
   */
  isOptional?: boolean;
  alternativeGroup?: string | null;
  isSelectedAlternative?: boolean;

  /**
   * Conjunto ("set") — the TAKE-ALL twin of `alternativeGroup`. Lines
   * sharing the same `setGroup` string are distinct standalone products
   * SOLD TOGETHER (e.g. an armchair + an ottoman). UNLIKE alternatives,
   * EVERY member is priced normally and counts toward the quote total;
   * they're just visually grouped and roll up to one "Total del
   * conjunto" = the simple SUM of each member's own `lineTotal` (see
   * lib/pricing:setSubtotal). There is NO separate set price and NO
   * set-level discount — each piece keeps its own price / qty / discount.
   *
   * null / undefined means the line is standalone.
   *
   * Mutually exclusive with `isOptional` and `alternativeGroup`: a line
   * in a set must be neither optional nor an alternative (the take-all
   * "all of these" semantic contradicts "maybe this" and "pick one").
   * The QuoteBuilder handlers strip those flags when a line joins a set
   * and a DB CHECK constraint (migration 20260523120000) forbids the
   * combination — mirroring the existing optional-xor-alternative rule.
   *
   * Because every set member is priced, isPricedLine (lib/constants)
   * needs NO special case for sets.
   */
  setGroup?: string | null;

  /* Internal-only — never rendered in client-facing surfaces. */
  notes?: string;
}

export interface Quote {
  id: string;
  profileId: string;
  customerId?: string | null;
  professionalId?: string | null;
  orderId?: string | null;
  /** auth.uid() of the user who closed the deal; commission attribution. */
  createdByUserId?: string | null;

  number?: number | null;
  status: QuoteStatus;

  /** Quote-level commission override for the professional. null = inherit. */
  commissionPct?: number | null;

  /**
   * How the assigned professional's cut is settled for accounting — the
   * SAME rate, two AR directions. Internal only; the client PDF always
   * shows the full price. Defaults to 'commission'. Only meaningful when
   * `professionalId` is set.
   */
  decoratorBilling?: DecoratorBilling;

  currencyCode?: CurrencyCode;
  /** Snapshot at draft time; live-overlaid in the workspace + PDF. */
  rates?: RatesMap;
  marginPct?: number;
  discountPct?: number;
  shipping?: number;

  terms?: string;
  notes?: string;

  /* Status-stepper timestamps. Only the active stage carries one. */
  sentAt?: number | null;
  acceptedAt?: number | null;
  declinedAt?: number | null;
  archivedAt?: number | null;

  /* Accepted-quote milestones (live on the QUOTE, not the order). */
  depositReceivedAt?: number | null;
  balancePaidAt?: number | null;
  deliveredAt?: number | null;
  depositAmount?: number | null;

  /* When the assigned professional's commission on this quote was PAID
   * OUT (Contabilidad tracking). null = pending. See commissionOwedAt()
   * in lib/commissions for when it becomes owed. */
  commissionPaidAt?: number | null;

  createdAt?: number;
  updatedAt?: number;
}

export interface Order {
  id: string;
  profileId: string;
  customerId?: string | null;
  number?: number;
  name?: string;
  status: OrderStatus;
  notes?: string;
  depositAmount?: number;
  deliveryAddress?: string;

  /* Stage timestamps — match orderStages.js timestampField names. */
  placedAt?: number | null;
  confirmedAt?: number | null;
  inTransitAt?: number | null;
  inCustomsAt?: number | null;
  receivedAt?: number | null;
  cancelledAt?: number | null;

  createdAt?: number;
  updatedAt?: number;
}

export interface Container {
  id: string;
  profileId: string;
  orderId: string;
  number?: number;
  name?: string;
  code?: string;
  /** When non-null, the container is packed and ready to dispatch. */
  filledAt?: number | null;
  notes?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ImageRecord {
  id: string;
  kind: string;
  ownerId?: string | null;
  label?: string;
  contentType: string;
  size: number;
  storagePath: string;
  createdAt?: number;
}

/* --------------------------------- materials --------------------------------- */

/**
 * `materials.category`. Fabrics + outdoor are priced per linear yard;
 * leather is priced per square meter and uses thickness (mm) instead
 * of width (in).
 */
export type MaterialCategory = 'fabric' | 'leather' | 'outdoor';

export interface MaterialColor {
  name: string;
  /** LR sku-fragment for the color, e.g. "4479" / "5312". */
  code: string;
  /**
   * Optional swatch image attached to the color, by `images.id`. The
   * material's "hero" thumbnail is simply the first color that carries
   * one — there is no separate material-level photo. The LR seed leaves
   * this null on all 850 imported colors; the dealer attaches them as
   * needed, including inline from the quote line's swatch slot.
   */
  imageId?: string | null;
}

export interface Material {
  id: string;
  profileId: string;
  category: MaterialCategory;
  /** Display name, e.g. "ALCANTARA - A", "DIVA", "CHARTRES". */
  name: string;
  /**
   * Single-letter grade — drives pricing tier on the parent product.
   * Maps to GRADE_GROUPS in lib/subtype. May be null on user-added
   * materials that haven't been graded yet.
   */
  grade?: string | null;
  /** LR wear-resistance code, e.g. "3C", "2B", "A". */
  wearRating?: string | null;
  /** Martindale / double-rubs count, e.g. 50000. */
  wearDoubleRubs?: number | null;
  /**
   * Numeric measure — width in inches for fabrics/outdoor, thickness
   * in millimetres for leather. The companion `measureUnit` field
   * disambiguates.
   */
  measure?: number | null;
  measureUnit?: 'in' | 'mm' | null;
  /** USD per `priceUnit`. */
  price?: number | null;
  priceUnit?: 'yard' | 'sm' | null;
  composition?: string | null;
  colors: MaterialColor[];
  notes?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/* ------------------------------ pricing math ------------------------------ */

/**
 * The shape `computeTotals` expects per line. `lineForTotals(line)`
 * is the canonical mapping from a `QuoteLine` (including compounds)
 * into this shape.
 */
export interface PricingLine {
  qty: number;
  basePrice: number;
  lineMarginPct?: number;
  lineDiscountPct?: number;
}

export interface PricingQuote {
  marginPct?: number;
  discountPct?: number;
  shipping?: number;
}

export interface Totals {
  subtotal: number;
  marginAmt: number;
  discountAmt: number;
  taxableBase: number;
  taxAmt: number;
  shipping: number;
  grandTotal: number;
  taxPct: number;
}
