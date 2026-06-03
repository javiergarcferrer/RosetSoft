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
import type { CurrencyCode, JournalEntry, JournalLine, Payment, PaymentMethod } from '../../types/domain.ts';

function cashRole(method: PaymentMethod): string {
  return method === 'cash' ? 'cash' : 'bank'; // card/transfer settle through the bank
}

/** Net amount actually deposited on a card cobro after the gateway's cut. */
export function paymentNet(p: Pick<Payment, 'amount' | 'commission' | 'commissionItbis' | 'itbisRetained' | 'isrRetained'>): number {
  return round2((p.amount || 0) - (p.commission || 0) - (p.commissionItbis || 0) - (p.itbisRetained || 0) - (p.isrRetained || 0));
}

/**
 * Card-type channels that route through the bank and may carry processor
 * deductions (commission + its ITBIS, retained ITBIS/ISR). Verifone (POS) and
 * the Banco Popular payment link are both card gateways; 'card' is the legacy
 * generic. Cash/transfer/bank settle clean (no gateway cut).
 */
export function isCardGateway(method: PaymentMethod): boolean {
  return method === 'card' || method === 'verifone' || method === 'payment_link';
}

/** Spanish UI labels for the payment methods. */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  transfer: 'Transferencia',
  bank: 'Banco',
  card: 'Tarjeta',
  verifone: 'Verifone',
  payment_link: 'Link de pago',
  credit: 'Crédito',
};

export interface BookedAmount {
  currency: CurrencyCode;
  /** Amount in `currency` actually received. */
  fxAmount: number;
  /** USD→DOP rate applied (1 for DOP). */
  rate: number;
  /** DOP figure that posts to the ledger. */
  amount: number;
}

/**
 * Translate a received cobro/pago into the DOP figure the ledger books. The
 * books are DOP: a USD payment converts at `rate` (Banco Popular venta), a DOP
 * payment passes through (rate 1). `received` is the amount in `currency`.
 * Pure; `amount` is round2 so nothing downstream ever sees rate drift.
 */
export function bookPaymentAmount(
  { received, currency, rate }: { received: number; currency: CurrencyCode; rate?: number | null },
): BookedAmount {
  const fxAmount = round2(received || 0);
  if (currency === 'USD') {
    const r = Number(rate) || 0;
    return { currency, fxAmount, rate: r, amount: round2(fxAmount * r) };
  }
  return { currency: 'DOP', fxAmount, rate: 1, amount: fxAmount };
}

export interface PaymentPostInput {
  id: string;
  direction: 'in' | 'out';
  partyType: 'customer' | 'supplier';
  partyId?: string | null;
  /** The DOP figure to book (already converted from `currency` at `rate`). */
  amount: number;
  method: PaymentMethod;
  /** Received-currency audit trail — surfaced in the asiento memo for USD. */
  currency?: CurrencyCode;
  rate?: number | null;
  fxAmount?: number | null;
  commission?: number;
  commissionItbis?: number;
  itbisRetained?: number;
  isrRetained?: number;
  reference?: string;
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
  const cash = requireAccount(config, cashRole(payment.method));
  const lines: DraftLine[] = [];

  // A USD cobro books DOP; record what was received in the asiento memo so the
  // journal is self-documenting (e.g. "Ref · US$1,000.00 @ 60.50").
  const fxNote = payment.currency === 'USD' && payment.fxAmount
    ? `US$${round2(payment.fxAmount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} @ ${payment.rate}`
    : '';
  const memo = [payment.reference, fxNote].filter(Boolean).join(' · ');

  if (payment.direction === 'in') {
    const commission = round2(payment.commission || 0);
    const commItbis = round2(payment.commissionItbis || 0);
    const retItbis = round2(payment.itbisRetained || 0);
    const retIsr = round2(payment.isrRetained || 0);
    const net = round2(gross - commission - commItbis - retItbis - retIsr);
    lines.push({ accountCode: cash, debit: net, memo });
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
    lines.push({ accountCode: cash, credit: gross, memo });
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
