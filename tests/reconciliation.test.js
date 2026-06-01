/**
 * Test for the bank-reconciliation ViewModel (src/core/accounting/reconciliation.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReconciliation } from '../src/core/accounting/reconciliation.js';

const accounts = [{ code: '1-01-001-02-00-00', name: 'BANCOS', nature: 'debit', isPostable: true }];
const entries = [{ id: 'e1', postedAt: 1, number: 1 }, { id: 'e2', postedAt: 2, number: 2 }, { id: 'e3', postedAt: 3, number: 3 }];
const lines = [
  { id: 'l1', entryId: 'e1', accountCode: '1-01-001-02-00-00', debit: 10000, credit: 0, reconciledAt: 123 },
  { id: 'l2', entryId: 'e2', accountCode: '1-01-001-02-00-00', debit: 0, credit: 3000, reconciledAt: null },
  { id: 'l3', entryId: 'e3', accountCode: '1-01-001-02-00-00', debit: 5000, credit: 0, reconciledAt: 456 },
];

test('resolveReconciliation: ledger vs reconciled vs pending + statement difference', () => {
  const r = resolveReconciliation({ accounts, entries, lines, accountCode: '1-01-001-02-00-00', statementBalance: 15000 });
  assert.equal(r.ledgerBalance, 12000);       // 10000 − 3000 + 5000
  assert.equal(r.reconciledBalance, 15000);   // 10000 + 5000 (the two reconciled)
  assert.equal(r.pendingBalance, -3000);      // the unreconciled −3000 line
  assert.equal(r.difference, 0);              // statement 15000 − reconciled 15000
  assert.equal(r.pendingCount, 1);
});
