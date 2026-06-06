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
 * Floor order ("venta de piso", 15% base commission) vs special order
 * (20%). Sets the assigned professional's base commission rate; chosen via
 * an explicit toggle on the quote, independent of order attachment.
 */
export type OrderType = 'floor' | 'special';

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
  /**
   * Logo of the exchange-rate source bank (Banco Popular Dominicano), shown
   * next to the converted DOP rate on the client link and the PDF. Uploaded
   * once in Settings (an SVG/PNG); null ⇒ no logo shown. Same image infra as
   * `logoImageId`.
   */
  rateLogoImageId?: string | null;
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
  /**
   * Accounting tax parameters + posting-account overrides (the role→code map).
   * Defaults live in `lib/accounting/config`; this holds only what the
   * accountant changed. See `resolveAccountingConfig`.
   */
  accountingConfig?: AccountingConfig;
  /**
   * The "house account" customer whose quotes stock the public storefront
   * (`/#/tienda`). Alcover quotes itself for store inventory; those quotes'
   * line items become the store's products. Chosen once in Settings; null ⇒ the
   * storefront is unconfigured and shows nothing. FK → customers (set null on
   * delete). See `supabase/functions/store` + `core/store`.
   */
  storeCustomerId?: string | null;
  /** Shopify catalog sync — store domain + last connection time (the Admin
   *  token lives in the write-only shopify_config table, never here). */
  shopifyDomain?: string;
  shopifyConnectedAt?: number | null;
  /** Issuer (emisor) RNC for e-CF / 607. */
  companyRnc?: string;
  /** Non-sensitive e-CF cert status (the .p12 itself lives in ecf_credentials). */
  ecfCertUploadedAt?: number | null;
  /** 'dev' (TesteCF) | 'cert' (CerteCF) | 'prod' (eCF). */
  ecfEnvironment?: string;
  /** Recipient for the monthly Ligne Roset sales report (the supplier's email).
   *  Prefills the "send to Ligne Roset" draft; null ⇒ draft opens with no To. */
  lrReportEmail?: string | null;
}

/**
 * Saved accounting configuration (overrides only — `resolveAccountingConfig`
 * fills the gaps from code defaults). `postingMap` maps a well-known posting
 * role (`salesLocal`, `itbisPayable`, `accountsPayable`…) to a chart account
 * code; the rates are percentages.
 */
export interface AccountingConfig {
  itbisRate?: number;
  dutyRate?: number;
  retentionIsrServicesRate?: number;
  retentionItbisRate?: number;
  postingMap?: Record<string, string>;
}

/** Supplier tax personhood — drives which retentions/606 columns apply. */
export type SupplierKind = 'fisica' | 'juridica' | 'exterior';

/**
 * A supplier (proveedor) for purchases and expenses. We act as withholding
 * agent for this supplier only when `retainIsr` / `retainItbis` are set
 * (owner's rule: retain when the supplier requires it).
 */
export interface Supplier {
  id: string;
  profileId: string;
  number?: number | null;
  name: string;
  rnc?: string;
  kind: SupplierKind;
  retainIsr?: boolean;
  retainItbis?: boolean;
  /**
   * Default posting (debit) account when recording a bill from this supplier:
   * Inventario for merchandise (Ligne Roset…), a Costo/Gasto for services.
   * Selectable in Proveedores; pre-fills the Gastos form (editable there).
   */
  defaultAccountCode?: string | null;
  email?: string;
  phone?: string;
  notes?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** How an expense was/will be settled. */
export type PaymentMethod = 'cash' | 'bank' | 'card' | 'credit';

/**
 * An operating expense (Gasto, class 6). Saving one posts a balanced asiento
 * (source='expense') and links it via `journalEntryId`; the 606 is a projection
 * of these rows. Amounts are DOP.
 */
export interface Expense {
  id: string;
  profileId: string;
  number?: number | null;
  supplierId?: string | null;
  expenseAt: number;
  ncf?: string;
  ncfType?: string;
  /** The class-6 account this gasto hits. */
  accountCode?: string | null;
  description?: string;
  base: number;
  itbis: number;
  itbisCreditable?: boolean;
  retentionIsr: number;
  retentionItbis: number;
  paymentMethod: PaymentMethod;
  paidAt?: number | null;
  journalEntryId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * A recognized sale (Facturación) — posted at delivery. Snapshots the booked
 * DOP figures + NCF and links to the asiento it generated. The 607 and the
 * ITBIS liquidation (IT-1) project off these. One per quote.
 */
export interface SalePosting {
  id: string;
  profileId: string;
  number?: number | null;
  quoteId?: string | null;
  customerId?: string | null;
  postedAt: number;
  ncf?: string;
  ncfType?: string;
  /** Fiscal id snapshot at posting (stable for the 607). */
  rnc?: string;
  base: number;
  itbis: number;
  total: number;
  depositApplied: number;
  rate?: number | null;
  usdTotal?: number | null;
  /* e-CF (comprobante fiscal electrónico) lifecycle. */
  ecfType?: string;
  ecfStatus?: string;
  trackId?: string;
  securityCode?: string;
  journalEntryId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * An authorized e-NCF range for one e-CF type (DGII). `nextSeq` advances as
 * e-NCF are issued; `expiresAt` is the FechaVencimientoSecuencia carried on the
 * e-CF. See `lib/accounting/ecf`.
 */
export interface ECFSequence {
  id: string;
  profileId: string;
  /** '31','32','33','34','41','43','44','45','46','47'. */
  ecfType: string;
  seqFrom: number;
  seqTo: number;
  nextSeq: number;
  expiresAt?: number | null;
  active?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export type PaymentDirection = 'in' | 'out';

/**
 * A cobro (in, from a customer) or pago (out, to a supplier). Posts a balanced
 * asiento (source='payment'). Card collections carry the gateway deductions
 * (commission + its ITBIS, retained ITBIS/ISR) — the bank gets the net, CxC
 * clears at the gross. Amounts are DOP.
 */
export interface Payment {
  id: string;
  profileId: string;
  number?: number | null;
  direction: PaymentDirection;
  partyType: 'customer' | 'supplier';
  partyId?: string | null;
  paidAt: number;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  commission: number;
  commissionItbis: number;
  itbisRetained: number;
  isrRetained: number;
  /** Invoice-level allocation: which documents this payment settles. */
  allocations?: { docId: string; docType?: string; amount: number }[];
  notes?: string;
  journalEntryId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * A fiscal month. A row with `status='closed'` locks that month — a DB trigger
 * rejects any asiento posted into it (cierre contable). No row ⇒ open.
 */
export interface FiscalPeriod {
  id: string;
  profileId: string;
  year: number;
  month: number;
  status: 'open' | 'closed';
  closedAt?: number | null;
  updatedAt?: number;
}

/** An employee on the payroll. */
export interface Employee {
  id: string;
  profileId: string;
  number?: number | null;
  name: string;
  cedula?: string;
  position?: string;
  monthlySalary: number;
  hireAt?: number | null;
  active?: boolean;
  notes?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** One employee's line within a payroll run (DOP). */
export interface PayrollItem {
  employeeId: string;
  name: string;
  gross: number;
  sfsEmp: number;
  afpEmp: number;
  isr: number;
  net: number;
  sfsPat: number;
  afpPat: number;
  infotepPat: number;
}

/** A monthly payroll run; posting it books one balanced asiento. */
export interface PayrollRun {
  id: string;
  profileId: string;
  number?: number | null;
  periodYear: number;
  periodMonth: number;
  paidAt: number;
  items: PayrollItem[];
  gross: number;
  tssEmp: number;
  isr: number;
  net: number;
  employerSs: number;
  employerInfotep: number;
  status?: string;
  journalEntryId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * A stock item. `qtyOnHand` + `avgCost` are caches maintained from the kardex
 * movements (the source of truth — see `lib/accounting/inventory`).
 */
export interface InventoryItem {
  id: string;
  profileId: string;
  sku?: string;
  name: string;
  unit?: string;
  qtyOnHand: number;
  avgCost: number;
  /** Permanent retail price set on the Alcover purchase order (store stock). */
  sellingPrice?: number | null;
  /** Photo uploaded at receiving (→ images.id). NOT a quote image. */
  imageId?: string | null;
  /** Linked Shopify product gid + last sync time (the catalog mirror). */
  shopifyProductId?: string | null;
  shopifySyncedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export type InventoryMovementType = 'in' | 'out' | 'adjust';

/** One kardex movement. `in` from a purchase/import, `out` for cost of sale. */
export interface InventoryMovement {
  id: string;
  profileId: string;
  itemId: string;
  type: InventoryMovementType;
  qty: number;
  unitCost: number;
  movedAt: number;
  refTable?: string | null;
  refId?: string | null;
  memo?: string;
  journalEntryId?: string | null;
  createdAt?: number;
}

/** Goods capitalize to inventory; asset/service hit a chart account directly. */
export type PurchaseKind = 'goods' | 'asset' | 'service';

/**
 * A purchase (Compra). Posts a balanced asiento (source='purchase'); a goods
 * purchase also creates an inventory IN movement. Amounts are DOP.
 */
export interface Purchase {
  id: string;
  profileId: string;
  number?: number | null;
  supplierId?: string | null;
  purchaseAt: number;
  ncf?: string;
  ncfType?: string;
  kind: PurchaseKind;
  /** For asset/service kind: the account debited. Goods use the inventory account. */
  accountCode?: string | null;
  /** For goods: the inventory item received + qty (drives the kardex IN). */
  itemId?: string | null;
  qty: number;
  base: number;
  itbis: number;
  itbisCreditable?: boolean;
  retentionIsr: number;
  retentionItbis: number;
  paymentMethod: PaymentMethod;
  paidAt?: number | null;
  journalEntryId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * A customs/import liquidation (liquidación aduanal / DGA). Lands imported goods
 * at their real RD cost: CIF + duty + clearance capitalize into landed cost; the
 * import ITBIS is input credit. Posts an asiento (source='import') + a kardex IN
 * at the landed unit cost. Amounts are DOP.
 */
export interface ImportLiquidation {
  id: string;
  profileId: string;
  number?: number | null;
  orderId?: string | null;
  supplierId?: string | null;
  itemId?: string | null;
  liquidatedAt: number;
  customsRef?: string;
  qty: number;
  cif: number;
  duty: number;
  importItbis: number;
  clearanceFees: number;
  otherCosts: number;
  paymentMethod: PaymentMethod;
  journalEntryId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * One itemized cost on an import expediente — agenciamiento (FDA), transporte,
 * puerto/almacenaje (Caucedo), tasa DGA, seguro… The NET (`amount − itbis`)
 * capitalizes into the goods' landed cost; the `itbis` is recoverable input
 * credit. A cost with a DR `supplierId` + `ncf` lands in the 606. `paymentMethod`
 * routes its credit: 'credit' → the supplier's CxP, else paid (bank/cash/card).
 */
export interface ImportCost {
  id: string;
  /** 'agenciamiento' | 'transporte' | 'puerto' | 'tasaDga' | 'seguro' | 'almacenaje' | 'otro' */
  concept: string;
  /** Free-text label override (shown instead of the concept's default name). */
  label?: string;
  supplierId?: string | null;
  ncf?: string | null;
  /** Total DOP for this cost, INCLUDING its ITBIS. */
  amount: number;
  /** Recoverable ITBIS portion of `amount` (0 / omitted = no creditable ITBIS). */
  itbis?: number;
  paymentMethod?: PaymentMethod;
}

/** One product line landed by an expediente — the goods + their value. FOB is
 *  the customs base (CIF = FOB + the embarque's prorated flete/seguro); selectivo
 *  is the ISC for this line's HS arancel (0 for most). */
export interface ImportExpedienteLine {
  id: string;
  itemId?: string | null;
  name: string;
  reference?: string;
  qty: number;
  /** FOB value (DOP) — the customs base before flete/seguro. */
  fob?: number;
  /** Impuesto Selectivo al Consumo (ISC) for this line — varies by HS arancel. */
  selectivo?: number;
  /** Legacy single-liquidation weight (this line's CIF). Superseded by `fob`. */
  cifValue?: number;
}

/** A supplier invoice within an embarque — its lines share a supplier (and NCF
 *  if it's a local invoice). The foreign supplier invoice seeds the FOB values. */
export interface ExpedienteFactura {
  id: string;
  supplierId?: string | null;
  invoiceRef?: string;
  ncf?: string | null;
  lines: ImportExpedienteLine[];
}

/** One embarque (shipment) of an expediente — a BL/contenedor with its own DUA,
 *  flete and seguro, holding one or more supplier facturas. */
export interface ExpedienteEmbarque {
  id: string;
  bl?: string;
  containerId?: string | null;
  customsRef?: string;   // DUA
  flete?: number;
  seguro?: number;
  facturas: ExpedienteFactura[];
}

/**
 * An import expediente = one customs FILE, possibly spanning several embarques
 * (BLs), each with several supplier facturas, each with product lines. The DGA
 * taxes are computed per line (gravamen 20% + selectivo + ITBIS 18% on the
 * cascade); an itemized cost sheet (agenciamiento, transporte, puerto…) is shared
 * across the whole expediente and prorated to every line by CIF. Posts one
 * asiento + a kardex IN per line at its landed unit cost. Amounts are DOP.
 */
export interface ImportExpediente {
  id: string;
  profileId: string;
  number?: number | null;
  /** Bill of lading — links to the tracked container. */
  bl?: string;
  customsRef?: string;
  supplierId?: string | null;   // foreign supplier (Roset)
  orderId?: string | null;
  containerId?: string | null;
  liquidatedAt: number;
  cif: number;          // total CIF / valor en aduana (derived from the embarques)
  duty: number;         // gravamen arancelario (total, derived)
  selectivo?: number;   // ISC (total, derived)
  importItbis: number;  // ITBIS de importación (creditable, derived)
  /** Multi-level structure: embarques → facturas → lines. */
  embarques?: ExpedienteEmbarque[];
  costs: ImportCost[];
  /** Legacy flat lines (single-embarque). Superseded by `embarques`. */
  lines: ImportExpedienteLine[];
  paymentMethod: PaymentMethod;  // settlement of the customs taxes
  journalEntryId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface Customer {
  id: string;
  profileId: string;
  name: string;
  /** Fiscal id (RNC / cédula) for the 607. Optional — consumidor final has none. */
  rnc?: string;
  /** Nombre comercial (the razón social goes in `name`). */
  company?: string;
  /** Person dealt with at the company — distinct from the razón social. */
  contactName?: string;
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
   * Price RANGE for a component quoted WITHOUT a chosen material — the mirror
   * of the line-level priceMin/priceMax, one level down. Both set ⇒ the
   * component (and the compound that holds it) shows "min – max"; picking a
   * material clears them and pins `unitPrice`. Lives on the JSONB component
   * shape — no DB column.
   */
  priceMin?: number | null;
  priceMax?: number | null;
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
   * The dealer designated this component as a CLIENT-toggleable optional
   * add-on (mirrors the line-level `optionalOffered`). Stable across client
   * picks, so the recipient can fold the sub-piece IN and back OUT on the
   * public share link; `isOptional` is the current include/exclude state.
   * Also lives on the JSONB component shape — no DB column.
   */
  optionalOffered?: boolean;
  /**
   * Component-level ALTERNATIVE (pick-one among sub-pieces) — the mirror of the
   * line-level alternativeGroup / isSelectedAlternative, scoped within one
   * compound. Members share an `alternativeGroup`; exactly one carries
   * `isSelectedAlternative` and is the one that counts toward the compound
   * subtotal (see lib/constants:isPricedComponent). Both live on the JSONB
   * component shape — no DB column. Mutually exclusive with `isOptional`.
   */
  alternativeGroup?: string | null;
  isSelectedAlternative?: boolean;
  /**
   * Fabric swatch image (by `images.id`) chosen via the SwatchPicker
   * for this component. Distinct from the parent line's imageId
   * (the product photo). Lives inline on the JSONB component shape.
   */
  swatchImageId?: string | null;
  /** Alternative-material options with price deltas (see MaterialOptions). */
  materialOptions?: MaterialOptions | null;
  /**
   * Module grouping — the catalog-agnostic link that turns a flat component list
   * into a MODULAR product (see lib/modules). Components sharing a `moduleGroup`
   * are the elements of ONE *component product* ("complete element" in Ligne
   * Roset terms) inside the modular; `moduleName` is that module's display label.
   * Authored by the dealer at assembly time (NOT derived from the catalog — the
   * price list carries no composition), so it works for every model. Both live
   * inline on the JSONB component shape — no DB column. Absent on a plain,
   * ungrouped component (which renders as its own single-element module).
   */
  moduleGroup?: string | null;
  moduleName?: string | null;
  /**
   * Module-level OPTIONAL — set on every element of a module (a component
   * product) to offer the WHOLE module as an opt-in add-on, excluded from the
   * total (the module twin of the line-level isOptional, distinct from a single
   * element's `isOptional`). Components may be optional add-ons but are never
   * alternatives — pick-one lives at the module/line level. Lives inline on the
   * JSONB component shape; no DB column. See lib/constants:isPricedComponent.
   */
  moduleOptional?: boolean;
  /**
   * Module-level ALTERNATIVE (pick-one among component products) — set on every
   * element of a module, the module twin of the line-level alternativeGroup.
   * Modules sharing `moduleAlternativeGroup` are siblings; the one whose members
   * carry `moduleSelected` is the priced choice (see isPricedComponent). Pick-one
   * lives at the module/line level — components themselves never carry it. Inline
   * on the JSONB shape; no DB column.
   */
  moduleAlternativeGroup?: string | null;
  moduleSelected?: boolean;
}

/**
 * Material options — present the same line/component in alternative upholstery
 * materials with the PRICE DELTA vs. the chosen base. Deltas are DERIVED at
 * render time from the catalog (a material's grade → the model SKU's price at
 * that grade), never frozen, so they stay correct if list prices change. The
 * line's own subtype/unitPrice stay the base; options are informational and do
 * NOT change the quote total.
 */
export interface MaterialOption {
  /** Grade letter of this option's material — drives its SKU price. */
  grade: string;
  /** Display label, e.g. "SOFT TOUCH" or "MATERIAL · COLOR". */
  label: string;
  /** Color code, for the Ligne Roset swatch fallback, when known. */
  code?: string | null;
  /** Uploaded swatch image (by images.id), when one exists. */
  swatchImageId?: string | null;
}

export interface MaterialOptions {
  /** Grade of the line's current (base) material — the $0 reference. */
  baseGrade: string;
  /** Display label of the base material. */
  baseLabel: string;
  options: MaterialOption[];
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
  /**
   * Additional product photos beyond the cover `imageId` — the dealer can
   * attach several angles / detail shots so the client sees the piece properly
   * on the share link. Ordered; the gallery shown is [imageId, ...extraImageIds].
   * Stored as a jsonb array (db column extra_image_ids); null/absent ⇒ no extras.
   */
  extraImageIds?: string[] | null;
  /** Alternative-material options with price deltas (see MaterialOptions). */
  materialOptions?: MaterialOptions | null;

  /* Pricing — ignored when `components` is non-empty (compound mode). */
  qty?: number;
  unitPrice?: number;
  /** Real wholesale cost (USD) snapshotted from the catalog when the line was
   *  added; drives the per-order margin view. Frozen so a later price-list
   *  update never rewrites an accepted order's margin. */
  unitCost?: number;
  lineMarginPct?: number;
  lineDiscountPct?: number;
  /**
   * Price RANGE for a line quoted WITHOUT a chosen material — the model's
   * cheapest→priciest fabric grade, snapshotted from the catalog when the line
   * is added (mirrors how `unitPrice` is snapshotted). Both set ⇒ the line
   * shows "min – max" instead of a single total and the quote total widens to a
   * range; picking a material clears them and pins `unitPrice`. Null on a
   * normal line. See lib/pricing:isRangeLine / computeTotalsRange.
   */
  priceMin?: number | null;
  priceMax?: number | null;

  /* Compound article — non-empty array makes this line compound. */
  components?: LineComponent[];
  /**
   * Composition tier of a compound line (see lib/modules). A `'componentProduct'`
   * — Ligne Roset's "complete element" — is one product made of elements (the
   * default, and how every existing compound reads when this is absent). A
   * `'modular'` is made of several component products, so its components are
   * grouped into named modules (`LineComponent.moduleGroup`) and the surfaces
   * render it grouped-by-module under one image. Only meaningful when
   * `components` is non-empty; ignored on a normal line.
   */
  compoundKind?: 'componentProduct' | 'modular';

  /* Product options + alternatives.
   *   isOptional               line currently EXCLUDED from the quote
   *                            total. isPricedLine (lib/constants) keys
   *                            off this; flipping it is what includes /
   *                            excludes the add-on.
   *   optionalOffered          the dealer designated this STANDALONE line
   *                            as an optional add-on the CLIENT may toggle
   *                            in or out on the public share link. Stable
   *                            across client picks, so the recipient can
   *                            turn an optional ON and back OFF (a true
   *                            toggle), unlike `isOptional` which the
   *                            include/exclude flips. A toggled-in optional
   *                            is `optionalOffered=true` + `isOptional=false`.
   *   alternativeGroup         id shared by sibling lines the
   *                            customer picks between; null means
   *                            the line is standalone.
   *   isSelectedAlternative    within a group, exactly one line
   *                            has this true and is the one that
   *                            counts toward the total. The others
   *                            still render so the customer sees
   *                            the menu.
   * Pricing math in lib/constants:isPricedLine respects isOptional +
   * the alternative flags (NOT optionalOffered — that's a UI/affordance
   * marker only); a DB CHECK constraint forbids the meaningless
   * combination (optional + alternative).
   */
  isOptional?: boolean;
  optionalOffered?: boolean;
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

/**
 * A catalog product imported from the Ligne Roset price-list CSV. The
 * searchable catalog behind "Agregar artículo": picking one autofills the
 * quote line and snapshots `cost` onto it for the margin view. `priceUsd` is
 * the list (Retail) price; `cost` is the real wholesale cost.
 */
export interface Product {
  id: string;
  profileId: string;
  reference: string;
  name?: string;
  subtype?: string;
  dimensions?: string;
  family?: string;
  familyCode?: string;
  category?: string;
  priceUsd?: number;
  cost?: number;
  active?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Per-model fabric availability, keyed by the family root (`splitSkuGrade`).
 * Captured from a Ligne Roset product page (`lr-catalog` single-product mode):
 * `patternNames` are the fabrics that model actually offers, stored normalized
 * (`fabricKey`) so they match `Material.name`. Used to restrict the material
 * picker to in-grade AND offered fabrics. See `src/lib/lrModelFabrics.js`.
 */
export interface ModelFabrics {
  id: string;            // the family root (e.g. "15420000")
  profileId: string;
  sourceUrl?: string | null;
  title?: string | null;
  patternNames: string[];
  fetchedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Per-group attributes for a Conjunto (set) or Alternativa, keyed by the same
 * id the member lines carry in `setGroup` / `alternativeGroup`. The flat
 * grouping + groupRuns are unchanged; this just hangs state off the group.
 *
 *   set + isOptional         → optional add-on, take-all-or-nothing.
 *   alternative + isOptional → "pick one or none" (menu may be left empty).
 */
export interface QuoteGroup {
  id: string;
  quoteId: string;
  type: 'set' | 'alternative';
  isOptional?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * One pinned fabric in a quote's curated material library ("Paleta del
 * proyecto"). Mirrors the swatch picker's emit shape ({ grade, fabric,
 * swatchImageId }) plus a stable id for keying/removal, so a pinned entry
 * applies to a line/component through the exact same path a fresh pick does
 * (grade reprice included). `fabric` is the composed "MATERIAL · COLOR (#code)".
 */
export interface QuoteMaterial {
  id: string;
  grade: string;
  fabric: string;
  swatchImageId?: string | null;
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
   * Floor order ('floor', 15% base commission) vs special order ('special',
   * 20%). Sets the professional's base rate AND the commission payout timing:
   * a floor order pays on the deposit; a special order is tied to a
   * container/order and pays on the balance (see commissionOwedAt).
   * Defaults to 'floor'.
   */
  orderType?: OrderType;

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
  /**
   * Friends & Family courtesy discount (%) — a SECOND quote-level discount,
   * independent of `discountPct`. Unlike the regular discount (which is drawn
   * out of the professional's commission dollar-for-dollar), the courtesy is
   * NOT drawn out: it lowers the base the commission is computed on, so the
   * designer earns the same % on the post-courtesy amount — a proportional
   * reduction, not a full one (see lib/commissions:commissionBreakdown). Shows
   * as a separate "Friends & Family" line on the client's bill. Applied after
   * `discountPct`, before ITBIS. Clamped to [0, 100]; default 0.
   */
  courtesyDiscountPct?: number;
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
  /* The professional commission $ frozen at payout time (snapshotted when
   * commissionPaidAt is set), so a later order_type toggle / base-rate change
   * can't restate what was paid. null = not paid → recompute live. */
  commissionPaidAmount?: number | null;

  /* When the SELLER (vendedor) commission on this quote was paid out.
   * null = pending. The seller's cut is earned once the deposit lands;
   * this is its sibling of commissionPaidAt (the professional's cut). */
  sellerCommissionPaidAt?: number | null;
  /* The seller commission $ frozen at payout time (sibling of
   * commissionPaidAmount), so editing the seller's profile commission_pct
   * later can't restate what was paid. null = not paid → recompute live. */
  sellerCommissionPaidAmount?: number | null;

  /* Public share link. `shareToken` is a random secret embedded in the
   * shareable URL (#/q/<token>); `shareEnabled` gates whether the link
   * resolves (lets the dealer revoke without losing the token).
   *
   * `clientSelections` is LEGACY: the share link used to store a recipient's
   * picks separately here, but the owner chose a single source of truth — the
   * `quote-share` function now applies picks directly to `quote_lines`, so this
   * column is no longer written. Kept (nullable) only so old rows type-check. */
  shareToken?: string | null;
  shareEnabled?: boolean;
  clientSelections?: ClientSelections | null;

  /** Curated per-quote material library — the fabrics pinned to this project,
   *  surfaced first in the material picker. See QuoteMaterial. */
  materialLibrary?: QuoteMaterial[] | null;

  createdAt?: number;
  updatedAt?: number;
}

/**
 * What a share-link recipient picked, persisted on the quote (plan A —
 * non-destructive). `alternatives` maps an alternativeGroup id to the line
 * id the client chose within it; `optionals` maps an optional line id to
 * whether the client wants it included; `materials` maps a line OR compound
 * component id to the material GRADE the client re-quoted it in (the base
 * grade, or one of the line's `materialOptions`). Absent keys fall back to
 * the dealer's own selection / the line's default base material.
 */
export interface ClientSelections {
  alternatives?: Record<string, string>;
  optionals?: Record<string, boolean>;
  materials?: Record<string, string>;
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
  /**
   * Set by a full catalog sync when this material is no longer offered
   * anywhere on the Ligne Roset site. Kept (not deleted) so dealer-only data
   * — per-yard price, grade, uploaded color photos, COM entries — survives;
   * `null` means active / on-site.
   */
  discontinuedAt?: number | null;
  /**
   * Set by a complete price-list (PDF) import when this material isn't found
   * in the price list — so it carries no current grade/price. Kept, not
   * deleted (it may be a website-only or custom entry); `null` means present
   * in the price list.
   */
  notInPricelistAt?: number | null;
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
  /** Friends & Family courtesy discount (%) — see Quote.courtesyDiscountPct. */
  courtesyDiscountPct?: number;
  shipping?: number;
}

export interface Totals {
  subtotal: number;
  marginAmt: number;
  discountAmt: number;
  /** Friends & Family courtesy discount $ — dealer-absorbed, never drawn from
   *  the professional's commission. See lib/pricing:computeTotals. */
  courtesyDiscountAmt: number;
  taxableBase: number;
  taxAmt: number;
  shipping: number;
  grandTotal: number;
  taxPct: number;
}

/* ------------------------------ accounting ------------------------------ */

/**
 * A chart-of-accounts node's normal balance side. Classes 1/5/6 are
 * debit-natured, 2/3/4 credit-natured (see `lib/accounting/chart`).
 */
export type AccountNature = 'debit' | 'credit';

/**
 * What business event produced a journal entry. 'manual' is hand-keyed; every
 * other value is emitted by the module that owns that event, so each operation
 * books itself (a sale at delivery, a purchase, an expense, a customs import…).
 */
export type JournalSource =
  | 'manual' | 'opening' | 'sale' | 'purchase' | 'expense' | 'payment'
  | 'import' | 'payroll' | 'depreciation' | 'fx' | 'tax' | 'gateway' | 'adjustment';

/**
 * One node of the chart of accounts (catálogo de cuentas). `code` is the
 * business key (`1-01-001-01-00-00`); only LEAF accounts (`isPostable`) take
 * postings — title accounts only aggregate their children. Seeded from the
 * advisor's DGII IR-2-aligned plan (migration 20260610120000).
 */
export interface Account {
  code: string;
  profileId: string;
  name: string;
  /** 1 Activos · 2 Pasivos · 3 Patrimonio · 4 Ingresos · 5 Costos · 6 Gastos. */
  class: number;
  nature: AccountNature;
  parentCode?: string | null;
  /** 1 = class root; deeper = more specific. Drives report indent. */
  level: number;
  /** Only leaf accounts receive journal lines. */
  isPostable: boolean;
  /** Optional DGII form box mapping (IR-2 / IT-1 …), set with the advisor. */
  dgiiBox?: string | null;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * A balanced double-entry asiento (header). The app guarantees Σ debit =
 * Σ credit across its lines (`lib/accounting/ledger`). Posted entries are never
 * edited or deleted — they're reversed by a mirror entry (`reversesId` /
 * `reversedById`), for audit.
 */
export interface JournalEntry {
  id: string;
  profileId: string;
  number?: number | null;
  /** Effective accounting date (JS ms). */
  postedAt: number;
  memo?: string;
  source: JournalSource;
  /** Link back to the operational row that generated the entry, e.g.
   *  `('quotes', <id>)` for a sale booked at delivery. */
  refTable?: string | null;
  refId?: string | null;
  reversesId?: string | null;
  reversedById?: string | null;
  createdByUserId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * One line of a journal entry: a single account debited OR credited. Amounts
 * are in DOP (the fiscal/functional currency); `usd` + `rate` keep the original
 * USD figure for traceability (operations are priced in USD, booked in DOP).
 * Exactly one of `debit`/`credit` is non-zero on a well-formed line.
 */
export interface JournalLine {
  id: string;
  profileId: string;
  entryId: string;
  accountCode: string;
  debit: number;
  credit: number;
  usd?: number | null;
  rate?: number | null;
  memo?: string;
  thirdPartyType?: string | null;
  thirdPartyId?: string | null;
  ncf?: string | null;
  sortOrder?: number;
  /** Set when the line was reconciled against the bank statement (else null). */
  reconciledAt?: number | null;
  createdAt?: number;
}
