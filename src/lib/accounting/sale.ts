/**
 * Sale posting Model — revenue recognition at DELIVERY (owner's rule).
 *
 * The deposit was booked earlier as a liability (cobros anticipados). At
 * delivery we recognize the sale: apply the deposit, bill the remainder as a
 * receivable, and credit revenue + ITBIS por pagar.
 *
 *   Debit  Cobros anticipados        depositApplied   (clears the liability)
 *   Debit  Cuentas por cobrar        total − depositApplied
 *   Credit Ventas locales            base
 *   Credit ITBIS por pagar           itbis
 *
 * Amounts are DOP (booked at the quote's locked rate). Cost of sale (COGS) is
 * intentionally NOT posted here — it lands with the inventory module (phase 4),
 * which holds the costed stock to credit. Pure: no React, no Supabase.
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import type { JournalEntry, JournalLine, PaymentMethod } from '../../types/domain.ts';

export interface SalePostInput {
  /** The sales_posting id (refId of the asiento). */
  id: string;
  quoteId?: string | null;
  customerId?: string | null;
  base: number;
  itbis: number;
  /** Deposit already received (DOP); applied against the sale at delivery. */
  deposit?: number;
  ncf?: string | null;
  memo?: string;
}

/** Clamp the deposit to [0, total] — never apply more than the sale is worth. */
export function depositApplied(deposit: number, total: number): number {
  return round2(Math.max(0, Math.min(Number(deposit) || 0, total)));
}

export function buildSaleEntry({
  newId, config, sale, postedAt,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  sale: SalePostInput;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const base = round2(sale.base);
  const itbis = round2(sale.itbis || 0);
  const total = round2(base + itbis);
  if (total <= 0) throw new Error('La venta no tiene monto a facturar.');
  const applied = depositApplied(sale.deposit || 0, total);
  const receivable = round2(total - applied);

  const lines: DraftLine[] = [];
  if (applied > 0) {
    lines.push({ accountCode: requireAccount(config, 'customerDeposits'), debit: applied });
  }
  if (receivable > 0) {
    lines.push({
      accountCode: requireAccount(config, 'accountsReceivable'),
      debit: receivable,
      thirdPartyType: sale.customerId ? 'customer' : null,
      thirdPartyId: sale.customerId || null,
      ncf: sale.ncf || null,
    });
  }
  lines.push({ accountCode: requireAccount(config, 'salesLocal'), credit: base });
  if (itbis > 0) {
    lines.push({ accountCode: requireAccount(config, 'itbisPayable'), credit: itbis });
  }

  return buildJournalEntry({
    newId,
    postedAt,
    source: 'sale',
    memo: sale.memo || 'Venta',
    refTable: 'sales_postings',
    refId: sale.id,
    lines,
  });
}

/** A paid invoice debits cash/bank; a credit one debits the receivable. */
function salePayRole(method: PaymentMethod | undefined): string {
  if (method === 'cash') return 'cash';
  if (method === 'card' || method === 'bank') return 'bank';
  return 'accountsReceivable';
}

export interface SalesBillPostInput {
  /** The sales_posting id (refId of the asiento). */
  id: string;
  customerId?: string | null;
  /** Revenue lines — each credits its own ingreso account; ITBIS is summed. */
  lines: ReadonlyArray<{ accountCode: string; base: number; itbis: number }>;
  /** Deposit already received (DOP); applied against the sale. */
  deposit?: number;
  /** Drives the debit side: cash/bank → cash/bank, else accounts receivable. */
  paymentMethod?: PaymentMethod;
  ncf?: string | null;
  memo?: string;
}

/**
 * Build a line-by-line SALE asiento — the credit-side mirror of buildBillEntry:
 *
 *   Debit  Cobros anticipados        depositApplied   (clears the liability)
 *   Debit  <CxC | caja | banco>      total − deposit
 *   Credit <each line's ingreso>      Σ line base, merged per account
 *   Credit ITBIS por pagar           Σ line ITBIS
 *
 * Each revenue line credits its own ingreso account (so a mixed invoice —
 * muebles + servicio + flete — splits across accounts), while the e-CF/607 read
 * the rolled-up gravado/itbis. Retentions are NOT booked here (the customer
 * withholds at payment, recorded by the cuentas module). Throws on a line with
 * no account or a zero invoice. Pure: no React, no Supabase.
 */
export function buildSalesBillEntry({
  newId, config, sale, postedAt,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  sale: SalesBillPostInput;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const itbis = round2(sale.lines.reduce((s, l) => s + round2(l.itbis || 0), 0));

  // Credit each distinct revenue account once, with the line bases merged.
  const byAccount = new Map<string, number>();
  for (const l of sale.lines) {
    const amt = round2(Math.max(0, Number(l.base) || 0));
    if (amt <= 0) continue;
    if (!l.accountCode) throw new Error('Cada línea necesita una cuenta de ingreso.');
    byAccount.set(l.accountCode, round2((byAccount.get(l.accountCode) || 0) + amt));
  }
  if (byAccount.size === 0) throw new Error('La factura no tiene líneas con monto.');
  const base = round2([...byAccount.values()].reduce((s, v) => s + v, 0));
  const total = round2(base + itbis);
  const applied = depositApplied(sale.deposit || 0, total);
  const receivable = round2(total - applied);

  const lines: DraftLine[] = [];
  if (applied > 0) lines.push({ accountCode: requireAccount(config, 'customerDeposits'), debit: applied });
  if (receivable > 0) {
    lines.push({
      accountCode: requireAccount(config, salePayRole(sale.paymentMethod)),
      debit: receivable,
      thirdPartyType: sale.customerId ? 'customer' : null,
      thirdPartyId: sale.customerId || null,
      ncf: sale.ncf || null,
    });
  }
  for (const [accountCode, amt] of byAccount) lines.push({ accountCode, credit: amt });
  if (itbis > 0) lines.push({ accountCode: requireAccount(config, 'itbisPayable'), credit: itbis });

  return buildJournalEntry({
    newId,
    postedAt,
    source: 'sale',
    memo: sale.memo || 'Factura de venta',
    refTable: 'sales_postings',
    refId: sale.id,
    lines,
  });
}

export interface CreditNoteDraftInput {
  /** The sale being credited (DOP figures booked at posting). */
  sale: { base: number; itbis: number; depositApplied?: number };
  /** 'full' = anulación total (código 1); 'partial' = corrección de monto (3). */
  kind: 'full' | 'partial';
  /** Credited base for a partial (DOP, net of ITBIS). Ignored for 'full'. */
  creditedBase?: number;
  itbisRate?: number;
  /** Base already credited by prior notas against this sale (DOP). */
  priorCreditedBase?: number;
}

export interface CreditNoteDraft {
  base: number;
  itbis: number;
  total: number;
  depositToRestore: number;
  /** 1 = anulación total, 3 = corrección de montos (DGII CodigoModificacion). */
  codigoModificacion: number;
}

/**
 * Resolve a nota de crédito's credited amounts from the original sale — the
 * pure core the issuance UI feeds into `buildCreditNoteEntry`.
 *
 * FULL (anulación total) credits the ENTIRE sale and restores the deposit that
 * was applied, so the asiento is the exact inverse of `buildSaleEntry`; it is
 * refused once any nota already exists against the sale (use partials for the
 * remainder). PARTIAL (corrección de monto) credits `creditedBase` + its ITBIS
 * against the receivable, restoring no deposit, and is clamped to the sale's
 * un-credited balance. Throws on a non-positive or over-crediting amount — fail
 * before the E34 e-NCF is burned. Pure.
 */
export function resolveCreditNoteDraft(input: CreditNoteDraftInput): CreditNoteDraft {
  const saleBase = round2(input.sale?.base || 0);
  const saleItbis = round2(input.sale?.itbis || 0);
  const prior = round2(input.priorCreditedBase || 0);
  const remainingBase = round2(saleBase - prior);

  if (input.kind === 'full') {
    if (prior > 0) {
      throw new Error('La venta ya tiene notas de crédito; usa una corrección parcial por el saldo restante.');
    }
    if (saleBase <= 0) throw new Error('La venta no tiene monto a acreditar.');
    return {
      base: saleBase,
      itbis: saleItbis,
      total: round2(saleBase + saleItbis),
      depositToRestore: round2(input.sale?.depositApplied || 0),
      codigoModificacion: 1,
    };
  }

  const base = round2(input.creditedBase || 0);
  if (base <= 0) throw new Error('El monto a acreditar debe ser mayor que cero.');
  if (base - remainingBase > 0.005) throw new Error('El monto a acreditar excede el saldo de la venta.');
  // Prorate the ORIGINAL sale's actual ITBIS by the credited share — never
  // recompute at the standard rate, or a tax-exempt sale (itbis 0) would have
  // ITBIS fabricated against it and the E34 / 607 / IT-1 would under-report tax.
  const itbis = saleBase > 0 ? round2(saleItbis * base / saleBase) : 0;
  return {
    base,
    itbis,
    total: round2(base + itbis),
    depositToRestore: 0,
    codigoModificacion: 3,
  };
}

export interface CreditNotePostInput {
  /** The credit-note sales_posting id (refId of the asiento). */
  id: string;
  quoteId?: string | null;
  customerId?: string | null;
  /** Credited base (DOP) — the original base for a full cancel, a slice for a partial. */
  base: number;
  /** Credited ITBIS (DOP). */
  itbis: number;
  /**
   * Deposit liability to RESTORE (becomes refundable to the customer); the rest
   * of the credit clears the receivable. A full cancel passes the deposit that
   * was applied to the original sale, so this asiento exactly mirrors it.
   */
  depositToRestore?: number;
  /** The credit note's own e-NCF (E34…). */
  ncf?: string | null;
  memo?: string;
}

/**
 * Build the nota de crédito asiento — the mirror of `buildSaleEntry` for the
 * credited amount. Reverses revenue + ITBIS por pagar, restoring the deposit
 * liability (refundable) and/or clearing the receivable:
 *
 *   Debit  Ventas locales            base       (un-recognizes revenue)
 *   Debit  ITBIS por pagar           itbis      (un-owes the tax)
 *   Credit Cobros anticipados        depositToRestore   (now refundable)
 *   Credit Cuentas por cobrar        total − depositToRestore
 *
 * For a full cancel: base/itbis = the original sale's, depositToRestore = the
 * deposit applied → this exactly unwinds buildSaleEntry. For a partial credit
 * with no deposit involvement: depositToRestore = 0 → it all lands on CxC
 * (a credit balance there is the refund the customer is owed). Pure.
 */
export function buildCreditNoteEntry({
  newId, config, note, postedAt,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  note: CreditNotePostInput;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const base = round2(note.base);
  const itbis = round2(note.itbis || 0);
  const total = round2(base + itbis);
  if (total <= 0) throw new Error('La nota de crédito no tiene monto a acreditar.');
  const restore = depositApplied(note.depositToRestore || 0, total);
  const receivable = round2(total - restore);

  const lines: DraftLine[] = [];
  lines.push({ accountCode: requireAccount(config, 'salesLocal'), debit: base });
  if (itbis > 0) {
    lines.push({ accountCode: requireAccount(config, 'itbisPayable'), debit: itbis });
  }
  if (restore > 0) {
    lines.push({ accountCode: requireAccount(config, 'customerDeposits'), credit: restore });
  }
  if (receivable > 0) {
    lines.push({
      accountCode: requireAccount(config, 'accountsReceivable'),
      credit: receivable,
      thirdPartyType: note.customerId ? 'customer' : null,
      thirdPartyId: note.customerId || null,
      ncf: note.ncf || null,
    });
  }

  return buildJournalEntry({
    newId,
    postedAt,
    source: 'sale',
    memo: note.memo || 'Nota de crédito',
    refTable: 'sales_postings',
    refId: note.id,
    lines,
  });
}
