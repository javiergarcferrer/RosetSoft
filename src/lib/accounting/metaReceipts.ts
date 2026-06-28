/**
 * Meta Ads receipts → Gasto draft — the pure Model behind "Meta receipts show
 * up in the books automatically".
 *
 * The `meta-receipts` Edge Function pulls one BILLING RECORD per closed cycle
 * from the Marketing API (the monthly invoice when the account is on Net-30
 * invoicing, else the cycle's account-level spend) and parks it as a PENDING
 * row. THIS module turns that row into the Expense the dealer reviews and posts
 * — centralizing the two things the books must never get wrong for a foreign
 * online-service vendor:
 *
 *  • MONEY. Meta bills the ad account in its OWN currency (USD for this dealer);
 *    the books are DOP. The conversion (× the USD→DOP rate snapshot taken at
 *    sync) lives here once, pinned by a test — reading the USD figure as DOP is
 *    a ~58× money bug.
 *  • DGII shape. Meta is an `exterior` supplier with NO Dominican NCF and no
 *    creditable ITBIS: the draft carries a BLANK NCF, base in DOP, itbis 0, and
 *    606 tipo '02' (servicios). Retentions stay 0 in the draft — they're the
 *    supplier's owner-rule, applied (if any) when the dealer confirms.
 *
 * No React, no Supabase, no network: a referentially-transparent projection
 * (Model layer, surfaced via core/accounting). The Edge Function (Deno) can't
 * import across the wall, so it stores `amountDop` denormalized for display;
 * THIS is the authoritative conversion used when the draft is actually posted.
 */
import { round2 } from './ledger.js';

/** A normalized Meta billing record, as the Edge Function persists it. */
export interface MetaBillingRecord {
  /** The ad account it billed through (`act_<id>` or the bare id). */
  adAccountId: string;
  /** Cycle bounds (ms). `periodStartAt` = first day, `periodEndAt` = last day.
   *  Named `*At` so the Dexie row-mapping converts the timestamptz columns to
   *  ms automatically — a persisted row feeds this Model untouched. */
  periodStartAt: number;
  periodEndAt: number;
  /** Billed amount in the AD ACCOUNT's currency (major units). */
  amount: number;
  /** Account currency — 'USD' or 'DOP' (the dealer's world). */
  currency: string;
  /** Where the figure came from: a real monthly invoice vs. summed spend. */
  source: 'invoice' | 'spend';
  /** The invoice PDF link (monthly-invoicing accounts only); else the billing
   *  page deep link. Pre-attached to the gasto so the receipt rides along. */
  invoiceUrl?: string | null;
  /** Meta's invoice number when on Net-30 invoicing. */
  invoiceNumber?: string | null;
}

const SPANISH_MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** `YYYY-MM` for a cycle, from its start (UTC — periods are UTC-anchored). */
export function billingPeriod(periodStartAt: number): string {
  const d = new Date(periodStartAt);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "junio 2026" — the human cycle label (UTC, matches `billingPeriod`). */
export function billingPeriodLabel(periodStartAt: number): string {
  const d = new Date(periodStartAt);
  return `${SPANISH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Strip Meta's `act_` prefix so the key is the bare account id. */
const bareAccount = (adAccountId: string): string =>
  String(adAccountId || '').replace(/^act_/, '');

/**
 * Stable id for a (account, cycle) pair — the dedup key. Re-syncing the same
 * cycle upserts the SAME row, so a draft is never double-created and a posted
 * one is never resurrected.
 */
export function metaReceiptKey(adAccountId: string, periodStartAt: number): string {
  return `metarcpt-${bareAccount(adAccountId)}-${billingPeriod(periodStartAt)}`;
}

/**
 * Account-currency amount → DOP base for the books. USD × the USD→DOP rate;
 * DOP passes through (rate ignored). Any other currency is unsupported — the
 * dealer's accounts only ever bill USD or DOP — and throws rather than silently
 * mis-booking. `dopRate` must be a positive USD→DOP rate for a USD account.
 */
export function metaAmountToDop(amount: number, currency: string, dopRate: number): number {
  const cur = String(currency || '').toUpperCase();
  if (cur === 'DOP') return round2(num(amount));
  if (cur === 'USD') {
    const rate = num(dopRate);
    if (rate <= 0) throw new Error('Falta la tasa USD→DOP para convertir el recibo de Meta.');
    return round2(num(amount) * rate);
  }
  throw new Error(`Moneda de cuenta no soportada para recibos de Meta: ${currency}.`);
}

export interface MetaReceiptDraftArgs {
  record: MetaBillingRecord;
  /** The `exterior` "Meta" supplier id (created/looked up by the View). */
  supplierId: string;
  /** The gasto account to debit — supplier default or the marketing account. */
  accountCode: string;
  /** USD→DOP rate to convert a USD billing record (snapshot at sync). */
  dopRate: number;
  /** Optional override for the gasto description. */
  description?: string;
}

/**
 * Project a billing record into an Expense-shaped DRAFT (same shape
 * `materializeExpense` yields, so the View posts it through `buildExpenseEntry`
 * untouched). The receipt link rides along as `attachmentUrl` so the document
 * is PRE-ATTACHED. NCF stays blank (Meta issues no Dominican comprobante).
 */
export function metaReceiptDraft({ record, supplierId, accountCode, dopRate, description }: MetaReceiptDraftArgs) {
  const base = metaAmountToDop(record.amount, record.currency, dopRate);
  const url = record.invoiceUrl || null;
  // A generated receipt PDF embeds inline in the gasto; a billing-hub fallback
  // stays an external link. Type drives the detail view's preview vs. link card.
  const isPdf = /\.pdf(\?|$)/i.test(url || '');
  return {
    supplierId: supplierId || null,
    accountCode: accountCode || null,
    description: description || `Meta Ads — ${billingPeriodLabel(record.periodStartAt)}`,
    // Booked at the cycle close (when the charge crystallizes), not "now".
    expenseAt: record.periodEndAt,
    ncf: '',
    ncfType: '',
    base,
    itbis: 0,
    // Foreign online service: no Dominican ITBIS to credit.
    itbisCreditable: false,
    retentionIsr: 0,
    retentionItbis: 0,
    // Card/PayPal billing settles out of the bank account; the dealer flips it
    // to 'bank' for a wire when on Net-30 invoicing.
    paymentMethod: 'card' as const,
    // DGII 606 casilla 3: trabajos, suministros y servicios.
    tipo606: '02',
    attachmentUrl: url,
    attachmentName: isPdf
      ? `Meta Ads ${billingPeriod(record.periodStartAt)}.pdf`
      : (record.invoiceNumber ? `Meta ${record.invoiceNumber}` : `Meta Ads ${billingPeriod(record.periodStartAt)}`),
    attachmentType: isPdf ? 'application/pdf' : 'link',
  };
}
