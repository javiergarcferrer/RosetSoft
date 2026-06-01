// Contabilidad dashboard ViewModel — the KPIs + roll-ups for the accounting
// home, composed from the other resolvers. Pure: no React, no db.
import { resolveReceivables, resolvePayables } from './receivables.js';
import { resolveItbisLiquidation } from './sales607.js';
import { resolveIncomeStatement, accountRawBalances, resolveJournal } from './ledger.js';
import { buildChartIndex, leafCodesUnder } from '../../lib/accounting/chart.js';
import { naturalBalance, round2 } from '../../lib/accounting/ledger.js';

/** Sum the natural balance of every postable leaf under a chart node. */
function subtreeBalance(index, raw, code) {
  let s = 0;
  for (const c of leafCodesUnder(index, code)) {
    const r = raw.get(c);
    const node = index.byCode.get(c);
    if (r && node) s += naturalBalance((r.debit || 0) - (r.credit || 0), node.nature);
  }
  return round2(s);
}

/**
 * @returns KPIs: cash (Cajas y Bancos), CxC/CxP balances, the month's
 *   ingresos/gastos/utilidad + ITBIS liquidation, e-CF pending count, overdue
 *   (+90) receivables, top debtors/creditors, and recent journal entries.
 */
export function resolveAccountingDashboard({
  accounts, entries, lines, salesPostings, purchases, expenses, payments, imports,
  customersById, suppliersById, monthStart, monthEnd,
} = {}) {
  const cxc = resolveReceivables({ salesPostings, payments, customersById });
  const cxp = resolvePayables({ purchases, expenses, payments, suppliersById });
  const itbis = resolveItbisLiquidation({ salesPostings, expenses, purchases, imports, start: monthStart, end: monthEnd });
  const income = resolveIncomeStatement({ accounts, lines, entries, start: monthStart, end: monthEnd });

  const index = buildChartIndex(accounts);
  const raw = accountRawBalances(lines);
  // 1-01-001 = Cajas y Bancos in the seeded catálogo.
  const cash = subtreeBalance(index, raw, '1-01-001-00-00-00');

  const ecfPending = (salesPostings || [])
    .filter((s) => /^E\d{2}/.test(s.ncf || '') && s.ecfStatus !== 'sent' && s.ecfStatus !== 'accepted').length;

  const recent = resolveJournal({ entries, lines, limit: 8 });

  return {
    cash,
    cxcBalance: cxc.totals.balance,
    cxpBalance: cxp.totals.balance,
    overdue: cxc.totals.d90,
    ingresosMonth: income.totalIncome,
    egresosMonth: round2(income.totalCosts + income.totalExpenses),
    utilidadMonth: income.netIncome,
    itbis,
    ecfPending,
    cxcTop: cxc.rows.slice(0, 5),
    cxpTop: cxp.rows.slice(0, 5),
    recent,
  };
}
