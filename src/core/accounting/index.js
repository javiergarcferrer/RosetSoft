// The accounting MODEL barrel — the single import surface for the Contabilidad
// pages. Commission/sales projections (the original surface) plus the
// general-ledger ViewModels and the Model helpers the Views need to post and
// render asientos.
//
// MVVM: Views import resolveX + the chart/posting helpers from here; they never
// reach into lib/accounting directly.

// ── per-sale commission + payout projections (the original accounting surface)
export { resolveSales, resolveCommissionPayout } from './sales.js';

// ── general-ledger ViewModels
export {
  accountRawBalances,
  resolveTrialBalance,
  resolveBalanceSheet,
  resolveIncomeStatement,
  resolveJournal,
  resolveAccountLedger,
} from './ledger.js';

// ── expenses (Gastos) ViewModels + the DGII 606 projection
export { resolveExpensesList, resolve606 } from './expenses.js';
export { computeExpenseTaxes, buildExpenseEntry } from '../../lib/accounting/expense.js';

// ── chart-of-accounts Model helpers (structure)
export {
  ACCOUNT_CLASS_NAMES,
  DEBIT_CLASSES,
  classOf,
  natureForClass,
  buildChartIndex,
  chartRoots,
  leafCodesUnder,
  postableAccounts,
} from '../../lib/accounting/chart.js';

// ── accounting configuration (tax params + posting-account map)
export {
  POSTING_ROLES,
  TAX_DEFAULTS,
  resolveAccountingConfig,
  accountFor,
  itbisOn,
} from '../../lib/accounting/config.js';

// ── posting Model (double-entry rules)
export {
  LEDGER_EPSILON,
  round2,
  debitTotal,
  creditTotal,
  entryImbalance,
  isBalanced,
  assertBalanced,
  naturalBalance,
  buildJournalEntry,
} from '../../lib/accounting/ledger.js';
