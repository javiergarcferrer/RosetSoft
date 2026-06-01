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

// ── sales (Facturación) ViewModels + the DGII 607 + IT-1 liquidation
export { resolveSales607, resolveItbisLiquidation } from './sales607.js';
export { buildSaleEntry, depositApplied } from '../../lib/accounting/sale.js';

// ── compras (Purchases) + inventario (kardex, weighted-average costing)
export { resolveInventory, resolveItemKardex } from './inventory.js';
export { buildPurchaseEntry, buildCogsEntry } from '../../lib/accounting/purchase.js';
export { resolveKardex, weightedAverageIn, round4 } from '../../lib/accounting/inventory.js';

// ── importación / liquidación DGA (landed cost)
export { resolveImportsList } from './imports.js';
export {
  buildImportEntry, computeImportTaxes, landedCost, landedUnitCost,
} from '../../lib/accounting/importLiquidation.js';

// ── e-CF (comprobante fiscal electrónico): types, e-NCF format, payload
export {
  ECF_TYPES, ecfTypeLabel, formatENcf, parseENcf, saleEcfType,
  sequenceState, pickSequence, padSeq,
} from '../../lib/accounting/ecf.js';
export { buildEcfPayload, formatEcfDate } from '../../lib/accounting/ecfPayload.js';

// ── cobros / pagos + cuentas por cobrar / pagar
export { resolveReceivables, resolvePayables, resolvePartyStatement } from './receivables.js';
export { buildPaymentEntry, paymentNet } from '../../lib/accounting/payment.js';

// ── dashboard KPIs
export { resolveAccountingDashboard } from './dashboard.js';

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
  buildReversalEntry,
} from '../../lib/accounting/ledger.js';
