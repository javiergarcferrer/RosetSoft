/**
 * Payment posting Model — cobros (from customers) and pagos (to suppliers).
 *
 * Cobro (cash/bank/transfer):     Debit Banco/Caja / Credit CxC
 * Cobro por tarjeta (gateway):    the processor keeps a commission (+ its ITBIS)
 *   and may retain ITBIS/ISR. The bank receives the NET; CxC clears at the GROSS:
 *     Debit Banco               net = gross − commission − commItbis − retITBIS − retISR
 *     Debit Comisiones tarjeta  commission
 *     Debit ITBIS adelantado    commItbis + retITBIS   (creditable)
 *     Debit Anticipo ISR        retISR
 *     Credit CxC                gross
 * Pago a suplidor:                Debit CxP / Credit Banco/Caja
 *
 * Pure: no React, no Supabase.
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import type { JournalEntry, JournalLine, Payment, PaymentMethod } from '../../types/domain.ts';

function cashRole(method: PaymentMethod): string {
  return method === 'cash' ? 'cash' : 'bank'; // card/transfer settle through the bank
}

/** Net amount actually deposited on a card cobro after the gateway's cut. */
export function paymentNet(p: Pick<Payment, 'amount' | 'commission' | 'commissionItbis' | 'itbisRetained' | 'isrRetained'>): number {
  return round2((p.amount || 0) - (p.commission || 0) - (p.commissionItbis || 0) - (p.itbisRetained || 0) - (p.isrRetained || 0));
}

export interface PaymentPostInput {
  id: string;
  direction: 'in' | 'out';
  partyType: 'customer' | 'supplier';
  partyId?: string | null;
  /** ALWAYS the DOP value posted to the ledger (the caller converts USD→DOP). */
  amount: number;
  method: PaymentMethod;
  commission?: number;
  commissionItbis?: number;
  itbisRetained?: number;
  isrRetained?: number;
  reference?: string;
  /** Currency the money moved in; defaults to DOP. */
  currency?: 'DOP' | 'USD';
  /** USD received and the rate used, stamped on the bank line when currency=USD. */
  usdAmount?: number | null;
  fxRate?: number | null;
  /** The configured bank account settling this payment (BankAccount.id). */
  bankAccountId?: string | null;
  /** Chart leaf the bank account posts to — overrides the generic `bank`/`cash`
   *  role so multiple bank accounts book to their own ledger account. */
  bankAccountCode?: string | null;
}

export function buildPaymentEntry({
  newId, config, payment, postedAt,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  payment: PaymentPostInput;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const gross = round2(payment.amount);
  if (gross <= 0) throw new Error('El monto del pago debe ser mayor que cero.');
  // The bank account's own chart leaf when configured, else the generic role.
  const cash = payment.bankAccountCode || requireAccount(config, cashRole(payment.method));
  // Foreign-currency stamp for the bank line: dollars received + the rate used.
  // The ledger amount stays DOP; usd/rate let a USD account reconcile in USD.
  const fx = payment.currency === 'USD'
    ? { usd: round2(payment.usdAmount || 0) || null, rate: payment.fxRate ?? null }
    : { usd: null, rate: null };
  const bankAccountId = payment.bankAccountId || null;
  const lines: DraftLine[] = [];

  if (payment.direction === 'in') {
    const commission = round2(payment.commission || 0);
    const commItbis = round2(payment.commissionItbis || 0);
    const retItbis = round2(payment.itbisRetained || 0);
    const retIsr = round2(payment.isrRetained || 0);
    const net = round2(gross - commission - commItbis - retItbis - retIsr);
    lines.push({ accountCode: cash, debit: net, memo: payment.reference || '', bankAccountId, ...fx });
    if (commission > 0) lines.push({ accountCode: requireAccount(config, 'cardCommissions'), debit: commission });
    const itbisCredit = round2(commItbis + retItbis);
    if (itbisCredit > 0) lines.push({ accountCode: requireAccount(config, 'itbisCredit'), debit: itbisCredit });
    if (retIsr > 0) lines.push({ accountCode: requireAccount(config, 'isrAdvance'), debit: retIsr });
    lines.push({
      accountCode: requireAccount(config, 'accountsReceivable'),
      credit: gross,
      thirdPartyType: 'customer',
      thirdPartyId: payment.partyId || null,
    });
  } else {
    lines.push({
      accountCode: requireAccount(config, 'accountsPayable'),
      debit: gross,
      thirdPartyType: 'supplier',
      thirdPartyId: payment.partyId || null,
    });
    lines.push({ accountCode: cash, credit: gross, memo: payment.reference || '', bankAccountId, ...fx });
  }

  return buildJournalEntry({
    newId,
    postedAt,
    source: 'payment',
    memo: payment.direction === 'in' ? 'Cobro' : 'Pago',
    refTable: 'payments',
    refId: payment.id,
    lines,
  });
}
