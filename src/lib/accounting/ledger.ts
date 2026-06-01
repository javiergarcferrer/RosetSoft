/**
 * General-ledger Model — the double-entry posting rules.
 *
 * The one invariant of the whole accounting system lives here: every journal
 * entry must balance (Σ debit = Σ credit). `assertBalanced` is the gate every
 * write goes through; `buildJournalEntry` assembles a ready-to-persist
 * entry+lines pair (the caller supplies a `newId` factory so this module never
 * imports the Supabase-backed `db`). Balances + projections for the statements
 * live in the ViewModel (`core/accounting/ledger`), built on the small math
 * helpers below.
 *
 * Amounts are in DOP (the fiscal/functional currency). Pure: no React, no
 * Supabase.
 */
import type { AccountNature, JournalEntry, JournalLine, JournalSource } from '../../types/domain.ts';

/** Float-sum tolerance — half a cent. Two-decimal money summed in JS can drift
 *  a few ulps; anything within this is "balanced". */
export const LEDGER_EPSILON = 0.005;

/** Round to 2 decimals (cents), the booking precision for DOP. */
export function round2(n: number | null | undefined): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** A line shape loose enough to accept both persisted lines and form drafts. */
export type LineLike = Pick<JournalLine, 'accountCode'> & {
  debit?: number | null;
  credit?: number | null;
};

export function debitTotal(lines: LineLike[] | null | undefined): number {
  return round2((lines || []).reduce((s, l) => s + (Number(l.debit) || 0), 0));
}
export function creditTotal(lines: LineLike[] | null | undefined): number {
  return round2((lines || []).reduce((s, l) => s + (Number(l.credit) || 0), 0));
}

/** Σ debit − Σ credit (rounded). Zero ⇒ the entry balances. */
export function entryImbalance(lines: LineLike[] | null | undefined): number {
  return round2(debitTotal(lines) - creditTotal(lines));
}

export function isBalanced(lines: LineLike[] | null | undefined): boolean {
  return Math.abs(entryImbalance(lines)) <= LEDGER_EPSILON;
}

/**
 * Throw a dealer-readable error unless `lines` form a valid balanced entry:
 *   • at least two lines,
 *   • each line names an account and carries exactly one of debit/credit (> 0),
 *   • Σ debit = Σ credit.
 * Returns true so it can be used as a guard expression.
 */
export function assertBalanced(lines: LineLike[] | null | undefined): true {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('Un asiento necesita al menos dos líneas.');
  }
  for (const l of lines) {
    const d = Number(l.debit) || 0;
    const c = Number(l.credit) || 0;
    if (!l.accountCode) throw new Error('Cada línea necesita una cuenta.');
    if (d < 0 || c < 0) throw new Error('Débitos y créditos no pueden ser negativos.');
    if (d > 0 && c > 0) throw new Error('Una línea no puede tener débito y crédito a la vez.');
    if (d === 0 && c === 0) throw new Error('Cada línea debe llevar un débito o un crédito.');
  }
  const imb = entryImbalance(lines);
  if (Math.abs(imb) > LEDGER_EPSILON) {
    throw new Error(
      `El asiento no cuadra: descuadre de ${imb.toFixed(2)} ` +
      `(Σ débito ${debitTotal(lines).toFixed(2)} ≠ Σ crédito ${creditTotal(lines).toFixed(2)}).`,
    );
  }
  return true;
}

/**
 * A debit−credit raw sum, re-signed to the account's NATURAL direction so a
 * positive balance always means "more of what this account normally holds":
 * debit accounts (assets/costs/expenses) grow on debits; credit accounts
 * (liabilities/equity/income) grow on credits.
 */
export function naturalBalance(rawDebitMinusCredit: number, nature: AccountNature): number {
  return nature === 'credit' ? -rawDebitMinusCredit : rawDebitMinusCredit;
}

/** Input line for `buildJournalEntry` — the booking intent, pre-persistence. */
export interface DraftLine {
  accountCode: string;
  debit?: number | null;
  credit?: number | null;
  usd?: number | null;
  rate?: number | null;
  memo?: string;
  thirdPartyType?: string | null;
  thirdPartyId?: string | null;
  ncf?: string | null;
}

export interface BuildEntryArgs {
  /** Id factory (pass `newId` from the data layer — keeps this module pure). */
  newId: () => string;
  profileId?: string;
  postedAt?: number;
  memo?: string;
  source?: JournalSource;
  refTable?: string | null;
  refId?: string | null;
  createdByUserId?: string | null;
  lines: DraftLine[];
}

/**
 * Assemble a persistable `{ entry, lines }` from a booking intent. Validates the
 * balance first (throws if it doesn't), assigns ids, stamps `sortOrder`, and
 * rounds amounts to cents. The caller persists with
 * `db.journalEntries.put(entry)` + `db.journalLines.bulkPut(lines)` and assigns
 * the human `number` via `assignSequenceNumber`.
 */
export function buildJournalEntry({
  newId,
  profileId = 'team',
  postedAt,
  memo = '',
  source = 'manual',
  refTable = null,
  refId = null,
  createdByUserId = null,
  lines,
}: BuildEntryArgs): { entry: JournalEntry; lines: JournalLine[] } {
  if (typeof newId !== 'function') {
    throw new Error('buildJournalEntry requires a newId() factory.');
  }
  assertBalanced(lines);
  const entryId = newId();
  const entry: JournalEntry = {
    id: entryId,
    profileId,
    number: null,
    postedAt: postedAt ?? Date.now(),
    memo,
    source,
    refTable,
    refId,
    createdByUserId,
  };
  const builtLines: JournalLine[] = lines.map((l, i) => ({
    id: newId(),
    profileId,
    entryId,
    accountCode: l.accountCode,
    debit: round2(l.debit || 0),
    credit: round2(l.credit || 0),
    usd: l.usd ?? null,
    rate: l.rate ?? null,
    memo: l.memo || '',
    thirdPartyType: l.thirdPartyType ?? null,
    thirdPartyId: l.thirdPartyId ?? null,
    ncf: l.ncf ?? null,
    sortOrder: i + 1,
  }));
  return { entry, lines: builtLines };
}
