// The accounting MODEL barrel — the single import surface for the Contabilidad
// pages. Commission/sales projections (the original surface) plus the
// general-ledger ViewModels and the Model helpers the Views need to post and
// render asientos.
//
// MVVM: Views import resolveX + the chart/posting helpers from here; they never
// reach into lib/accounting directly.

// ── per-sale commission + payout projections (the original accounting surface)
export { resolveSales, resolveCommissionsOverview, resolveWorkspaceEntries } from './sales.js';

// ── general-ledger ViewModels
export {
  accountRawBalances,
  resolveTrialBalance,
  resolveBalanceSheet,
  resolveIncomeStatement,
  resolveBalanceSheetComparison,
  resolveIncomeStatementComparison,
  resolveChartTree,
  resolveJournal,
  resolveAccountLedger,
} from './ledger.js';

// ── estado de flujo de efectivo (cash-flow statement, direct method)
export { resolveCashFlow, CASHFLOW_SOURCE_LABEL } from './cashflow.js';

// ── presupuesto vs. real (budgets vs actuals)
export { resolveBudgetVariance } from './budgets.js';

// ── expenses (Gastos) ViewModels + the DGII 606 projection
export { resolveExpensesList, resolve606 } from './expenses.js';
export { computeExpenseTaxes, buildExpenseEntry } from '../../lib/accounting/expense.js';

// ── compras y gastos (unified pane): the merged + filterable list VM + natures
export {
  resolvePurchasesExpenses, resolvePurchaseExpenseDetail, purchaseNature, NATURES, NATURE_LABEL,
} from './compras.js';

// ── sales (Facturación) ViewModels + the DGII 607 + IT-1 liquidation
export { resolveSales607, resolveItbisLiquidation } from './sales607.js';

// ── invoice pipeline (AR funnel: por cobrar / vencida / cobrada + e-CF backlog)
export { resolveInvoicePipeline } from './invoices.js';

// ── DGII Formato de Envío TXT builders (606/607 Oficina Virtual files)
export { dgii606Txt, dgii607Txt, dgiiPeriod, dgiiTxtFilename, collectionSplit } from './dgiiFormats.js';

// ── Ligne Roset supplier sell-through report (monthly floor sales)
export {
  resolveLrSales, lrSalesCsv, lrSalesEmail, monthLabel, monthRange, previousMonth,
} from './lrSales.js';
export { buildSaleEntry, buildSalesBillEntry, buildCreditNoteEntry, resolveCreditNoteDraft, depositApplied } from '../../lib/accounting/sale.js';
export { resolveInvoiceDoc } from './invoiceDoc.js';
export { resolveReceptorInbox } from './receptorInbox.js';

// ── compras (Purchases) + inventario (kardex, weighted-average costing)
export { resolveInventory, resolveItemKardex } from './inventory.js';
export { buildPurchaseEntry, buildCogsEntry, planSalida, resolvePurchaseLines } from '../../lib/accounting/purchase.js';
export { DR_TAX_PRESETS, taxPresetById, applyLineTaxes } from '../../lib/accounting/taxPresets.js';
export { resolveBillLines, buildBillEntry } from '../../lib/accounting/bill.js';
export { resolveKardex, weightedAverageIn, round4 } from '../../lib/accounting/inventory.js';

// ── importación / liquidación DGA (landed cost)
export {
  resolveImportsList, resolveImportacionesList, resolveExpedienteDetail, expedienteEmbarques, PAYMENT_LABELS,
  resolveCustomsTaxes,
} from './imports.js';
export {
  buildImportEntry, computeImportTaxes, landedCost, landedUnitCost, allocateShipment,
} from '../../lib/accounting/importLiquidation.js';
export {
  COST_CONCEPTS, costLabel, prorateCif, computeLineTaxes, resolveExpediente, expedienteCostTotals,
  expedienteLanded, expedienteCreditableItbis, expedienteTaxCheck, buildExpedienteEntry,
} from '../../lib/accounting/expediente.js';

// ── landed-cost CALCULATOR (interactive simulator): VM + the pure engine/presets
export { resolveLandedCalculator } from './landedCalculator.js';
export {
  computeLanded, allocate, priceForMargin, marginForPrice, incotermFor, bucketDef, regimeDuty,
  INCOTERMS, COST_BUCKETS, ALLOCATION_METHODS, ORIGIN_REGIMES, FURNITURE_HS, DGA_DEFAULTS,
} from '../../lib/accounting/landedCalc.js';

// ── e-CF (comprobante fiscal electrónico): types, e-NCF format, payload
export {
  ECF_TYPES, ecfTypeLabel, formatENcf, parseENcf, saleEcfType, saleTipoPago, saleDueDate, isValidFiscalId, isCreditNote,
  parseEcfFechaEmision, sequenceState, pickSequence, padSeq, ecfQrUrl,
} from '../../lib/accounting/ecf.js';
export { buildEcfPayload, formatEcfDate } from '../../lib/accounting/ecfPayload.js';
export { buildCommercialApproval, formatEcfDateTime, ACECF_ESTADO } from '../../lib/accounting/ecfCommercial.js';

// ── fiscal jurisdiction PLUGIN seam — the country-agnostic engine reads the
// active plugin (DGII today) for the tax name/rate, fiscal-id format, e-CF
// receipt and the periodic filings, so a jurisdiction move swaps one module.
export { activeFiscalPlugin, dgiiPlugin, FISCAL_PLUGINS, resolveFilingDeadline } from './fiscal/index.js';

// ── cobros / pagos + cuentas por cobrar / pagar
export { resolveReceivables, resolvePayables, resolvePartyStatement, resolveStatementFor } from './receivables.js';
export { buildPaymentEntry, paymentNet } from '../../lib/accounting/payment.js';

// ── dashboard KPIs
export { resolveAccountingDashboard } from './dashboard.js';

// ── cockpit (command center): today-scoped deadlines + period close + actions
export { resolveAccountingCockpit } from './cockpit.js';

// ── panel analytics (comparative periods, segmentation, 360° roll-ups)
export {
  resolvePeriod, stepPeriodRef, deltaPct, resolveComparativeKpis,
  resolveSalesSegmented, resolveMonthlyComparative, resolveExpenseComparative,
  resolveImportPanel,
} from './analytics.js';

// ── conciliación bancaria + importación de estados (Banco Popular…)
export { resolveReconciliation } from './reconciliation.js';
export { resolveBankImport } from './bankImport.js';
export {
  parseBankStatement, matchStatementToLedger, firstMatchingRule, ruleMatches, BANK_PROFILES,
} from '../../lib/accounting/bankStatement.js';

// ── caja chica (petty cash): funds + vales VM + the posting Model
export { resolveCajaChica, resolveFundLedger } from './cajaChica.js';
export {
  pettyCashBalance, voucherCashDelta, buildPettyCashEntry, VOUCHER_TYPE_LABEL,
} from '../../lib/accounting/pettyCash.js';

// ── cobranza / dunning: the collections-queue VM + the cadence Model
export { resolveCollectionsQueue } from './collections.js';
export {
  resolveDunningPolicy, DEFAULT_DUNNING_POLICY, planReminders, dueStepFor, fillTemplate,
} from '../../lib/accounting/dunning.js';

// ── recurrentes (memorized recurring transactions): agenda VM + schedule Model
export { resolveRecurring } from './recurring.js';
export { nextOccurrence, isDue, advance, materializeExpense } from '../../lib/accounting/recurring.js';

// ── bitácora / audit trail (DGII inalterability)
export { resolveAuditTrail } from './auditLog.js';

// ── nómina (payroll): monthly TSS+ISR engine, date-keyed topes, overtime + the
// regalía / liquidación / bonificación asiento builders
export {
  DR_PAYROLL, SMC_HISTORY, ratesForPeriod, DAILY_DIVISOR, MONTHLY_HOURS, PREMIUM_FACTOR, overtimePay,
  annualIsr, monthlyIsr, computePayrollItem, payrollTotals, buildPayrollEntry,
  buildRegaliaEntry, buildLiquidacionEntry, buildBonificacionEntry,
} from '../../lib/accounting/payroll.js';

// ── prestaciones / derechos adquiridos: regalía, vacaciones, liquidación, bonificación
export {
  dailyWage, vacationDays, vacationProportionalDays, vacationPay, regaliaPascual,
  monthsOfService, preavisoDays, cesantiaDays, asistenciaEconomicaDays, liquidacion,
  BONIFICACION_RATE, bonificacionCapDays, bonificacionRun,
} from '../../lib/accounting/prestaciones.js';

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
