/**
 * Caja chica (petty cash) Model — the fund balance and the balanced asiento each
 * voucher (vale) posts. Pure: no React, no Supabase.
 *
 * The fund runs on the imprest system: an `opening` seeds a fixed amount of cash
 * into a dedicated class-1 account (funded from bank or general cash); each
 * `expense` vale debits the gasto (+ the creditable ITBIS when the vale carries
 * an NCF) and credits the fund account; a `replenishment` tops the cash back up;
 * an `adjustment` books an arqueo over/short. Every voucher posts a real asiento,
 * so the petty-cash gasto flows into the ledger statements automatically, and a
 * vale with an NCF additionally feeds the DGII 606 (see core/accounting/expenses).
 *
 * Amounts are DOP.
 */
import type { PettyCashFund, PettyCashVoucher, PettyCashVoucherType } from '../../types/domain.ts';
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';

/** Human labels for the voucher kinds (used by the VM + the page). */
export const VOUCHER_TYPE_LABEL: Record<PettyCashVoucherType, string> = {
  opening: 'Apertura',
  expense: 'Vale de gasto',
  replenishment: 'Reposición',
  adjustment: 'Arqueo',
};

/** Signed cash effect of one voucher on its fund (DOP): cash in (+), out (−). */
export function voucherCashDelta(
  v: Pick<PettyCashVoucher, 'type' | 'total' | 'direction'>,
): number {
  switch (v.type) {
    case 'opening':
    case 'replenishment':
      return round2(v.total);
    case 'expense':
      return -round2(v.total);
    case 'adjustment':
      return v.direction === 'over' ? round2(v.total) : -round2(v.total);
    default:
      return 0;
  }
}

/** Book cash balance of a fund from its vouchers (optionally one fund). */
export function pettyCashBalance(
  vouchers: PettyCashVoucher[] | null | undefined,
  fundId?: string,
): number {
  return round2(
    (vouchers || [])
      .filter((v) => !fundId || v.fundId === fundId)
      .reduce((s, v) => round2(s + voucherCashDelta(v)), 0),
  );
}

/** The JournalSource a voucher books under (refTable disambiguates further). */
const SOURCE_FOR: Record<PettyCashVoucherType, 'opening' | 'manual' | 'expense' | 'adjustment'> = {
  opening: 'opening',
  replenishment: 'manual',
  expense: 'expense',
  adjustment: 'adjustment',
};

/**
 * The balanced asiento a petty-cash voucher posts.
 *   • opening / replenishment — Debit caja chica, Credit bank (or general cash).
 *   • expense (vale) — Debit gasto (+ Debit ITBIS adelantado when creditable),
 *     Credit caja chica for the full cash out. Non-creditable ITBIS is expensed.
 *   • adjustment (arqueo) — faltante: Debit the chosen gasto, Credit caja;
 *     sobrante: Debit caja, Credit the chosen income account.
 */
export function buildPettyCashEntry({
  newId,
  config,
  fund,
  voucher,
  postedAt,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  fund: Pick<PettyCashFund, 'accountCode'>;
  voucher: PettyCashVoucher;
  postedAt?: number;
}) {
  const fundAcct = fund?.accountCode || requireAccount(config, 'cash');
  let lines: DraftLine[];

  if (voucher.type === 'opening' || voucher.type === 'replenishment') {
    const amount = round2(voucher.total);
    if (!(amount > 0)) throw new Error('El monto de la caja chica debe ser mayor que cero.');
    const fundedFrom = voucher.paymentMethod === 'cash'
      ? requireAccount(config, 'cash')
      : requireAccount(config, 'bank');
    lines = [
      { accountCode: fundAcct, debit: amount },
      { accountCode: fundedFrom, credit: amount },
    ];
  } else if (voucher.type === 'expense') {
    if (!voucher.accountCode) throw new Error('El vale necesita una cuenta de gasto.');
    const base = round2(voucher.base);
    const itbis = round2(voucher.itbis || 0);
    const creditable = voucher.itbisCreditable !== false && itbis > 0;
    const cashOut = round2(base + itbis);
    if (!(cashOut > 0)) throw new Error('El vale debe tener un monto mayor que cero.');
    // Creditable ITBIS is recovered separately (debit the advance); otherwise the
    // whole cash-out lands on the gasto.
    lines = [{ accountCode: voucher.accountCode, debit: creditable ? base : cashOut, ncf: voucher.ncf || null }];
    if (creditable) lines.push({ accountCode: requireAccount(config, 'itbisCredit'), debit: itbis });
    lines.push({ accountCode: fundAcct, credit: cashOut });
  } else if (voucher.type === 'adjustment') {
    if (!voucher.accountCode) throw new Error('El arqueo necesita una cuenta de sobrante o faltante.');
    const amount = round2(voucher.total);
    if (!(amount > 0)) throw new Error('La diferencia del arqueo debe ser mayor que cero.');
    lines = voucher.direction === 'over'
      // sobrante: physical cash exceeds the books → add to the fund, credit income
      ? [{ accountCode: fundAcct, debit: amount }, { accountCode: voucher.accountCode, credit: amount }]
      // faltante: cash is short → expense the difference, take it out of the fund
      : [{ accountCode: voucher.accountCode, debit: amount }, { accountCode: fundAcct, credit: amount }];
  } else {
    throw new Error(`Tipo de vale desconocido: ${String(voucher.type)}`);
  }

  return buildJournalEntry({
    newId,
    profileId: voucher.profileId,
    postedAt: postedAt ?? voucher.voucherAt,
    memo: voucher.description || `Caja chica — ${VOUCHER_TYPE_LABEL[voucher.type] || voucher.type}`,
    source: SOURCE_FOR[voucher.type] || 'manual',
    refTable: 'petty_cash_vouchers',
    refId: voucher.id,
    lines,
  });
}
