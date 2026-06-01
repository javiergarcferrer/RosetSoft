/**
 * Test for the Contabilidad dashboard ViewModel (src/core/accounting/dashboard.js)
 * — cash from the ledger's Cajas-y-Bancos subtree, CxC balance, month income,
 * and the e-CF-pending count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingDashboard } from '../src/core/accounting/dashboard.js';

const ACCOUNTS = [
  { code: '1-00-000-00-00-00', class: 1, nature: 'debit', parentCode: null, level: 1, isPostable: false, name: 'ACTIVOS' },
  { code: '1-01-000-00-00-00', class: 1, nature: 'debit', parentCode: '1-00-000-00-00-00', level: 2, isPostable: false, name: 'AC CORRIENTES' },
  { code: '1-01-001-00-00-00', class: 1, nature: 'debit', parentCode: '1-01-000-00-00-00', level: 3, isPostable: false, name: 'CAJAS Y BANCOS' },
  { code: '1-01-001-02-00-00', class: 1, nature: 'debit', parentCode: '1-01-001-00-00-00', level: 4, isPostable: true, name: 'BANCOS' },
  { code: '4-00-000-00-00-00', class: 4, nature: 'credit', parentCode: null, level: 1, isPostable: false, name: 'INGRESOS' },
  { code: '4-01-001-01-00-00', class: 4, nature: 'credit', parentCode: '4-00-000-00-00-00', level: 4, isPostable: true, name: 'VENTAS' },
];
const MONTH = 1_000_000_000;
const ENTRIES = [{ id: 'e1', postedAt: MONTH + 1 }];
const LINES = [
  { entryId: 'e1', accountCode: '1-01-001-02-00-00', debit: 10000, credit: 0 },
  { entryId: 'e1', accountCode: '4-01-001-01-00-00', debit: 0, credit: 10000 },
];

test('resolveAccountingDashboard rolls up cash, CxC, month income and e-CF pending', () => {
  const d = resolveAccountingDashboard({
    accounts: ACCOUNTS, entries: ENTRIES, lines: LINES,
    salesPostings: [{ customerId: 'c1', postedAt: MONTH + 1, total: 11800, depositApplied: 0, ncf: 'E310000000001', ecfStatus: 'pending' }],
    purchases: [], expenses: [], payments: [], imports: [],
    customersById: new Map([['c1', { id: 'c1', name: 'Cliente A' }]]),
    suppliersById: new Map(),
    monthStart: MONTH, monthEnd: MONTH + 1_000_000,
  });
  assert.equal(d.cash, 10000);          // bank balance from the ledger
  assert.equal(d.cxcBalance, 11800);    // open receivable
  assert.equal(d.ingresosMonth, 10000); // income in the window
  assert.equal(d.utilidadMonth, 10000); // no costs/expenses
  assert.equal(d.ecfPending, 1);        // one un-transmitted e-NCF
  assert.equal(d.cxcTop.length, 1);
});
