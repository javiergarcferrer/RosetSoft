// Recording a customer/supplier payment (cobro/pago) to the ledger — the one
// imperative write path, shared by the Cuentas por cobrar form, the payment-plan
// card, and the collections board so they can't drift.
//
// This is the SERVICE layer (it touches Supabase via `db`): it takes the pure
// payment input + the resolved accounting config, runs the pure
// `buildPaymentEntry` Model, and persists the asiento + lines + payment row in
// the exact sequence the Cuentas form always used:
//   1) journal entry (sequence-numbered)   2) journal lines
//   3) payment row (sequence-numbered) with allocations + journalEntryId.

import { db, newId, assignSequenceNumber } from './database.js';
import { buildPaymentEntry } from '../lib/accounting/payment.js';

/**
 * Post a payment and return its ids. `payment` is the pure input
 * ({ direction, partyType, partyId, amount, method, reference, allocations,
 * commission?, … }); `config` is a ResolvedAccountingConfig; `scope` the
 * profileId. The same gross/net/allocation rules as the manual cobro apply.
 */
export async function recordPayment({ scope, config, payment, postedAt }) {
  const id = payment.id || newId();
  const at = postedAt || Date.now();
  const direction = payment.direction || 'in';
  const partyType = payment.partyType || (direction === 'in' ? 'customer' : 'supplier');
  const common = {
    id,
    direction,
    partyType,
    partyId: payment.partyId || null,
    amount: Number(payment.amount) || 0,
    method: payment.method || 'bank',
    reference: payment.reference || '',
    commission: Number(payment.commission) || 0,
    commissionItbis: Number(payment.commissionItbis) || 0,
    itbisRetained: Number(payment.itbisRetained) || 0,
    isrRetained: Number(payment.isrRetained) || 0,
    // Currency + bank-account context (default DOP / generic bank).
    currency: payment.currency === 'USD' ? 'USD' : 'DOP',
    usdAmount: payment.usdAmount != null ? Number(payment.usdAmount) || 0 : null,
    fxRate: payment.fxRate != null ? Number(payment.fxRate) || 0 : null,
    bankAccountId: payment.bankAccountId || null,
  };

  // bankAccountCode steers WHICH ledger leaf the bank line books to; it's
  // derived from the chosen bank account, not a stored payment column.
  const built = buildPaymentEntry({
    newId, config, postedAt: at,
    payment: { ...common, bankAccountCode: payment.bankAccountCode || null },
  });

  // 1) journal entry  2) lines  3) payment row — same order as the manual form.
  await assignSequenceNumber({
    table: 'journalEntries', profileId: scope, start: 1,
    build: (n) => ({ ...built.entry, number: n }),
  });
  await db.journalLines.bulkPut(built.lines);

  const allocations = (payment.allocations || []).filter((a) => a && Number(a.amount) > 0);
  await assignSequenceNumber({
    table: 'payments', profileId: scope, start: 1,
    build: (n) => ({
      ...common,
      profileId: scope,
      number: n,
      paidAt: at,
      allocations,
      journalEntryId: built.entry.id,
    }),
  });

  return { id, journalEntryId: built.entry.id };
}
