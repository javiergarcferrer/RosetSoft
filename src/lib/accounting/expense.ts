/**
 * Expense (Gasto) posting Model — turns a captured expense into a balanced
 * asiento, and computes its ITBIS + retentions from the fiscal config.
 *
 * The asiento (class-6 gasto, paid or on credit, with optional retentions):
 *   Debit  <gasto account>            base
 *   Debit  ITBIS adelantado            itbis            (creditable; no exempt ops)
 *   Credit <bank|cash|suplidores>      net = base+itbis − retISR − retITBIS
 *   Credit Retención ISR (IR-17)       retISR           (only if we withhold)
 *   Credit ITBIS retenido              retITBIS         (only if we withhold)
 *
 * Pure: no React, no Supabase (the caller passes `newId`).
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { accountFor, itbisOn, type ResolvedAccountingConfig } from './config.js';
import type { Expense, JournalEntry, JournalLine, PaymentMethod } from '../../types/domain.ts';

export interface ExpenseTaxParts {
  itbis: number;
  retIsr: number;
  retItbis: number;
  /** Net amount actually payable/paid = base + itbis − retentions. */
  net: number;
}

/**
 * Derive an expense's ITBIS and retentions from a base amount. Retentions only
 * apply when the supplier flags say so (owner's rule); rates come from config.
 */
export function computeExpenseTaxes({
  base,
  retainIsr = false,
  retainItbis = false,
  config,
}: {
  base: number;
  retainIsr?: boolean;
  retainItbis?: boolean;
  config: ResolvedAccountingConfig;
}): ExpenseTaxParts {
  const b = round2(base);
  const itbis = itbisOn(b, config);
  const retIsr = retainIsr ? round2((b * config.retentionIsrServicesRate) / 100) : 0;
  const retItbis = retainItbis ? round2((itbis * config.retentionItbisRate) / 100) : 0;
  return { itbis, retIsr, retItbis, net: round2(b + itbis - retIsr - retItbis) };
}

/** Which posting role settles a payment method. */
function payRole(method: PaymentMethod): string {
  if (method === 'credit') return 'accountsPayable';
  if (method === 'cash') return 'cash';
  return 'bank'; // 'bank' and 'card' both settle out of the bank account
}

/** Resolve a posting role to a code, or throw — a missing mapping mis-books. */
function req(config: ResolvedAccountingConfig, role: string): string {
  const code = accountFor(config, role);
  if (!code) throw new Error(`Cuenta no configurada para el rol "${role}".`);
  return code;
}

export interface BuildExpenseEntryArgs {
  newId: () => string;
  config: ResolvedAccountingConfig;
  expense: Pick<Expense,
    'id' | 'supplierId' | 'accountCode' | 'description' | 'base' | 'itbis' |
    'retentionIsr' | 'retentionItbis' | 'paymentMethod' | 'ncf'>;
  postedAt?: number;
}

/**
 * Build the balanced asiento for an expense. Throws (via assertBalanced inside
 * buildJournalEntry) if the numbers don't reconcile.
 */
export function buildExpenseEntry({
  newId, config, expense, postedAt,
}: BuildExpenseEntryArgs): { entry: JournalEntry; lines: JournalLine[] } {
  const base = round2(expense.base);
  const itbis = round2(expense.itbis || 0);
  const retIsr = round2(expense.retentionIsr || 0);
  const retItbis = round2(expense.retentionItbis || 0);
  const net = round2(base + itbis - retIsr - retItbis);

  const gastoAccount = expense.accountCode;
  if (!gastoAccount) throw new Error('El gasto necesita una cuenta de gasto.');

  const lines: DraftLine[] = [
    { accountCode: gastoAccount, debit: base, memo: expense.description || '' },
  ];
  if (itbis > 0) {
    lines.push({ accountCode: req(config, 'itbisCredit'), debit: itbis });
  }
  lines.push({
    accountCode: req(config, payRole(expense.paymentMethod)),
    credit: net,
    thirdPartyType: expense.supplierId ? 'supplier' : null,
    thirdPartyId: expense.supplierId || null,
    ncf: expense.ncf || null,
  });
  if (retIsr > 0) lines.push({ accountCode: req(config, 'isrWithheld'), credit: retIsr });
  if (retItbis > 0) lines.push({ accountCode: req(config, 'itbisWithheld'), credit: retItbis });

  return buildJournalEntry({
    newId,
    postedAt,
    source: 'expense',
    memo: expense.description || 'Gasto',
    refTable: 'expenses',
    refId: expense.id,
    lines,
  });
}
