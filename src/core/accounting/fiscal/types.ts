// The country-agnostic FISCAL JURISDICTION contract.
//
// AlcoverSoft's accounting engine is jurisdiction-neutral: it knows about
// sales, postings, the ledger and commissions, but NOTHING about the Dominican
// DGII. Every DR-specific rule — the ITBIS rate, the RNC/cédula format, the
// e-CF comprobante, the 606/607/IT-1 filings — lives behind THIS interface, in
// a "fiscal plugin". The Dominican plugin (./dgii) implements it today; moving
// the business to Puerto Rico means writing a `pr` plugin (IVU, EIN, Modelo
// 480…) against the SAME shape and registering it — the engine and every
// screen above it stay untouched.
//
// So the rule is: the rest of the app reads `plugin.tax.name`, never the string
// "ITBIS"; `plugin.fiscalId.label`, never "RNC". The seam is what makes the
// engine portable.

/** The value-added / sales tax of a jurisdiction (DR: ITBIS, PR: IVU). */
export interface FiscalTax {
  /** Display name — what every screen shows instead of a hardcoded "ITBIS". */
  name: string;
  /** General rate, in percent. */
  defaultRate: number;
  /** Tax due on a taxable base at `rate` (defaults to `defaultRate`). */
  on(base: number, rate?: number): number;
}

/** The taxpayer identifier of a jurisdiction (DR: RNC/cédula, PR: EIN/SSN). */
export interface FiscalId {
  /** Field label (DR: "RNC / Cédula"). */
  label: string;
  /** Is `value` a well-formed id for this jurisdiction? */
  isValid(value: string | null | undefined): boolean;
}

/** A receipt type the jurisdiction defines (DR e-CF: 31 Crédito Fiscal, …). */
export interface FiscalReceiptType {
  code: string;
  label: string;
}

/**
 * The fiscal receipt (comprobante) a jurisdiction issues for a sale. DR issues
 * the electronic e-CF; a jurisdiction without one sets `receipt` to null.
 */
export interface FiscalReceipt {
  /** Issued/transmitted electronically (DR e-CF). */
  electronic: boolean;
  /** Short name (DR: "e-CF"). */
  label: string;
  /** The defined types. */
  types: FiscalReceiptType[];
  typeLabel(code: string): string;
  /** Which type a sale gets, given whether the buyer is a registered taxpayer. */
  typeForSale(hasFiscalId: boolean): string;
}

/** A periodic filing the jurisdiction requires (DR: 606, 607, IT-1). */
export interface FiscalReport {
  /** Filing code (DR: "606"). */
  code: string;
  label: string;
  description: string;
  /** Route the View opens to work this filing. */
  to: string;
  /** Family, so a View can group/route without knowing the code. */
  kind: 'purchases' | 'sales' | 'liquidation' | 'receipt';
  /** Calendar day of the month AFTER the period by which the filing is due (DR:
   *  606/607 → 15, IT-1 → 20). Omitted for non-periodic filings (per-document
   *  e-CF). A View turns this into a live deadline via `resolveFilingDeadline`. */
  dueDay?: number;
}

/**
 * A fiscal jurisdiction plugin — everything country-specific about the books,
 * behind one stable shape. Register a new one (e.g. Puerto Rico) in
 * ./index and the engine becomes portable with zero changes above this line.
 */
export interface FiscalPlugin {
  /** ISO 3166-1 alpha-2 jurisdiction code (DR: "DO"). */
  country: string;
  /** Human label (DR: "República Dominicana"). */
  label: string;
  /** Tax authority (DR: "DGII", PR: "Hacienda"). */
  authority: string;
  tax: FiscalTax;
  fiscalId: FiscalId;
  /** The fiscal receipt, or null where the jurisdiction issues none. */
  receipt: FiscalReceipt | null;
  /** The periodic filings, in display order. */
  reports: FiscalReport[];
}
