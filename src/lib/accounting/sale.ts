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
import type { JournalEntry, JournalLine } from '../../types/domain.ts';

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
