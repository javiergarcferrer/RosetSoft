// Bank-reconciliation ViewModel — a bank account's ledger lines with their
// reconciled flag, the reconciled vs. pending balances, and the difference
// against the statement's ending balance. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

export function resolveReconciliation({
  accounts, entries, lines, accountCode, bankAccountId, accountCurrency = 'DOP', statementBalance,
} = {}) {
  const account = (accounts || []).find((a) => a.code === accountCode) || null;
  const dates = new Map((entries || []).map((e) => [e.id, e.postedAt || 0]));
  const memos = new Map((entries || []).map((e) => [e.id, e.memo || '']));
  const nums = new Map((entries || []).map((e) => [e.id, e.number]));

  // A line belongs to this account if it's TAGGED with the configured bank
  // account (when one is selected), or — for legacy/untagged lines — it sits on
  // the chart leaf. So newly-tagged cobros AND older lines on the leaf both show.
  const belongs = (l) => (bankAccountId
    ? (l.bankAccountId === bankAccountId || (!l.bankAccountId && l.accountCode === accountCode))
    : l.accountCode === accountCode);

  const rows = (lines || [])
    .filter(belongs)
    .map((l) => {
      const amount = round2((Number(l.debit) || 0) - (Number(l.credit) || 0));
      // For a USD account, expose the dollars (signed by debit/credit direction)
      // so the page can display them; DOP `amount` stays untouched.
      const usd = accountCurrency === 'USD'
        ? round2((amount < 0 ? -1 : 1) * Math.abs(Number(l.usd) || 0))
        : null;
      return {
        line: l,
        postedAt: dates.get(l.entryId) || 0,
        memo: memos.get(l.entryId) || '',
        number: nums.get(l.entryId) ?? null,
        amount,
        usd,
        reconciled: !!l.reconciledAt,
      };
    })
    .sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0));

  const ledgerBalance = round2(rows.reduce((s, r) => s + r.amount, 0));
  const reconciledBalance = round2(rows.filter((r) => r.reconciled).reduce((s, r) => s + r.amount, 0));
  const pendingBalance = round2(ledgerBalance - reconciledBalance);
  const difference = statementBalance != null && statementBalance !== ''
    ? round2((Number(statementBalance) || 0) - reconciledBalance)
    : null;

  return {
    account, rows, ledgerBalance, reconciledBalance, pendingBalance, difference,
    accountCurrency, bankAccountId: bankAccountId || null,
    count: rows.length, pendingCount: rows.filter((r) => !r.reconciled).length,
  };
}
