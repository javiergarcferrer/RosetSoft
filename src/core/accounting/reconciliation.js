// Bank-reconciliation ViewModel — a bank account's ledger lines with their
// reconciled flag, the reconciled vs. pending balances, and the difference
// against the statement's ending balance. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

export function resolveReconciliation({ accounts, entries, lines, accountCode, statementBalance } = {}) {
  const account = (accounts || []).find((a) => a.code === accountCode) || null;
  const dates = new Map((entries || []).map((e) => [e.id, e.postedAt || 0]));
  const memos = new Map((entries || []).map((e) => [e.id, e.memo || '']));
  const nums = new Map((entries || []).map((e) => [e.id, e.number]));

  const rows = (lines || [])
    .filter((l) => l.accountCode === accountCode)
    .map((l) => ({
      line: l,
      postedAt: dates.get(l.entryId) || 0,
      memo: memos.get(l.entryId) || '',
      number: nums.get(l.entryId) ?? null,
      amount: round2((Number(l.debit) || 0) - (Number(l.credit) || 0)),
      reconciled: !!l.reconciledAt,
    }))
    .sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0));

  const ledgerBalance = round2(rows.reduce((s, r) => s + r.amount, 0));
  const reconciledBalance = round2(rows.filter((r) => r.reconciled).reduce((s, r) => s + r.amount, 0));
  const pendingBalance = round2(ledgerBalance - reconciledBalance);
  const difference = statementBalance != null && statementBalance !== ''
    ? round2((Number(statementBalance) || 0) - reconciledBalance)
    : null;

  return {
    account, rows, ledgerBalance, reconciledBalance, pendingBalance, difference,
    count: rows.length, pendingCount: rows.filter((r) => !r.reconciled).length,
  };
}
