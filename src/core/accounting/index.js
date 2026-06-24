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

// ── expenses (Gastos) ViewModels + the DGII 606 projection
export { resolveExpensesList, resolve606 } from './expenses.js';
export { computeExpenseTaxes, buildExpenseEntry } from '../../lib/accounting/expense.js';

// ── compras y gastos (unified pane): the merged + filterable list VM + natures
export {
  resolvePurchasesExpenses, resolvePurchaseExpenseDetail, purchaseNature, NATURES, NATURE_LABEL,
} from './compras.js';

// ── sales (Facturación) ViewModels + the DGII 607 + IT-1 liquidation
export { resolveSales607, resolveItbisLiquidation } from './sales607.js';

// ── DGII Formato de Envío TXT builders (606/607 Oficina Virtual files)
export { dgii606Txt, dgii607Txt, dgiiPeriod, dgiiTxtFilename, collectionSplit } from './dgiiFormats.js';

// ── Ligne Roset supplier sell-through report (monthly floor sales)
export {
  resolveLrSales, lrSalesCsv, lrSalesEmail, monthLabel, monthRange, previousMonth,
} from './lrSales.js';
export { buildSaleEntry, buildCreditNoteEntry, resolveCreditNoteDraft, depositApplied } from '../../lib/accounting/sale.js';
export { resolveInvoiceDoc } from './invoiceDoc.js';

// ── compras (Purchases) + inventario (kardex, weighted-average costing)
export { resolveInventory, resolveItemKardex } from './inventory.js';
export { buildPurchaseEntry, buildCogsEntry, planSalida, resolvePurchaseLines } from '../../lib/accounting/purchase.js';
export { resolveKardex, weightedAverageIn, round4 } from '../../lib/accounting/inventory.js';

// ── importación / liquidación DGA (landed cost)
export {
  resolveImportsList, resolveImportacionesList, resolveExpedienteDetail, expedienteEmbarques, PAYMENT_LABELS,
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
  sequenceState, pickSequence, padSeq, ecfQrUrl,
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

// ── conciliación bancaria
export { resolveReconciliation } from './reconciliation.js';

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
