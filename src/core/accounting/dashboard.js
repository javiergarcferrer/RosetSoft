// Contabilidad dashboard ViewModel — the KPIs, time-series and roll-ups for the
// accounting home (QuickBooks-style "Business overview"), composed from the
// other resolvers. Pure: no React, no db.
import { resolveReceivables, resolvePayables } from './receivables.js';
import { resolveItbisLiquidation } from './sales607.js';
import { resolveIncomeStatement, accountRawBalances, resolveJournal } from './ledger.js';
import { buildChartIndex, leafCodesUnder, chartRoots } from '../../lib/accounting/chart.js';
import { naturalBalance, round2 } from '../../lib/accounting/ledger.js';
import { pickSequence, sequenceState, ecfTypeLabel } from '../../lib/accounting/ecf.js';

/**
 * e-NCF range health for the types the team issues (31/32) — running out of
 * authorized sequence numbers HALTS invoicing, so the panel warns ahead:
 *   • 'none'     — ranges exist for the type but none is usable any more.
 *   • 'low'      — the usable range has ≤ `lowAt` numbers left.
 *   • 'expiring' — the usable range dies within `soonDays`.
 * Types with no configured ranges at all stay silent (pre-e-CF operation).
 */
export function resolveEcfSequenceAlerts(sequences, { now = Date.now(), lowAt = 10, soonDays = 30 } = {}) {
  const alerts = [];
  for (const type of ['31', '32']) {
    const ofType = (sequences || []).filter((s) => s.ecfType === type);
    if (ofType.length === 0) continue;
    const usable = pickSequence(ofType, type, now);
    if (!usable) { alerts.push({ type, label: ecfTypeLabel(type), kind: 'none' }); continue; }
    const st = sequenceState(usable, now);
    if (st.remaining <= lowAt) {
      alerts.push({ type, label: ecfTypeLabel(type), kind: 'low', remaining: st.remaining });
    } else if (usable.expiresAt != null && usable.expiresAt - now < soonDays * 86_400_000) {
      alerts.push({ type, label: ecfTypeLabel(type), kind: 'expiring', expiresAt: usable.expiresAt });
    }
  }
  return alerts;
}

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const CASH_ROOT = '1-01-001-00-00-00'; // Cajas y Bancos, in the seeded catálogo.
const DAY = 86_400_000;

/** A month-bucket key that orders correctly across years. */
function monthKey(ts) {
  const d = new Date(ts || 0);
  return d.getFullYear() * 12 + d.getMonth();
}

/** The last `count` months ending in the month of `endTs`, oldest first. */
function lastMonths(endTs, count) {
  const end = new Date(endTs || Date.now());
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    out.push({ key: d.getFullYear() * 12 + d.getMonth(), label: MONTHS_ES[d.getMonth()] });
  }
  return out;
}

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
 * @returns KPIs + widgets: cash (Cajas y Bancos), CxC/CxP balances + aging, the
 *   month's ingresos/gastos/utilidad + ITBIS liquidation, e-CF pending count,
 *   top debtors/creditors, recent journal entries, AND the "Business overview"
 *   series: `monthsSeries` (6-month ingresos/egresos/ventas/flujo), `expenseDonut`
 *   (gastos by category this month), `bankAccounts` (per-account cash balances),
 *   `ar` (cobros aging split) and `collected30` (cobrado últimos 30 días).
 */
export function resolveAccountingDashboard({
  accounts, entries, lines, salesPostings, purchases, expenses, payments, imports, expedientes,
  ecfSequences, customersById, suppliersById, monthStart, monthEnd,
} = {}) {
  const end = monthEnd ?? Date.now();
  const cxc = resolveReceivables({ salesPostings, payments, customersById });
  const cxp = resolvePayables({ purchases, expenses, payments, suppliersById });
  const itbis = resolveItbisLiquidation({ salesPostings, expenses, purchases, imports, expedientes, start: monthStart, end });
  const income = resolveIncomeStatement({ accounts, lines, entries, start: monthStart, end });

  const index = buildChartIndex(accounts);
  const raw = accountRawBalances(lines);
  const cashLeaves = new Set(leafCodesUnder(index, CASH_ROOT));
  const cash = subtreeBalance(index, raw, CASH_ROOT);

  // Per-account cash balances → the "Bank accounts" card.
  const bankAccounts = [];
  for (const code of cashLeaves) {
    const node = index.byCode.get(code);
    if (!node) continue;
    const r = raw.get(code);
    const bal = r ? round2(naturalBalance((r.debit || 0) - (r.credit || 0), node.nature)) : 0;
    if (Math.abs(bal) > 0.001) bankAccounts.push({ code, name: node.name, balance: bal });
  }
  bankAccounts.sort((a, b) => b.balance - a.balance);

  // 6-month series: ingresos/egresos/utilidad (clases 4 vs 5+6), cash in/out
  // (movements on Cajas y Bancos), and ventas (salesPostings.total) per month.
  const months = lastMonths(end, 6);
  const idxByKey = new Map(months.map((m, i) => [m.key, i]));
  const entryDate = new Map((entries || []).map((e) => [e.id, e.postedAt || 0]));
  const series = months.map((m) => ({ label: m.label, ingresos: 0, egresos: 0, sales: 0, cashIn: 0, cashOut: 0 }));
  for (const l of lines || []) {
    const i = idxByKey.get(monthKey(entryDate.get(l.entryId) || 0));
    if (i == null) continue;
    const node = index.byCode.get(l.accountCode);
    if (!node) continue;
    const debit = Number(l.debit) || 0;
    const credit = Number(l.credit) || 0;
    if (node.class === 4) series[i].ingresos += naturalBalance(debit - credit, node.nature);
    else if (node.class === 5 || node.class === 6) series[i].egresos += naturalBalance(debit - credit, node.nature);
    if (cashLeaves.has(l.accountCode)) { series[i].cashIn += debit; series[i].cashOut += credit; }
  }
  for (const sp of (salesPostings || []).filter((s) => !s.voidedAt)) {
    const i = idxByKey.get(monthKey(sp.postedAt || 0));
    if (i != null) series[i].sales = round2(series[i].sales + (Number(sp.total) || 0));
  }
  for (const s of series) {
    s.ingresos = round2(s.ingresos);
    s.egresos = round2(s.egresos);
    s.cashIn = round2(s.cashIn);
    s.cashOut = round2(s.cashOut);
    s.utilidad = round2(s.ingresos - s.egresos);
  }

  // Gastos (clase 6) by top-level category, this month → the donut.
  const rawMonth = accountRawBalances(lines, { entries, start: monthStart, end });
  const class6 = chartRoots(index).find((r) => r.class === 6);
  let cats = [];
  if (class6) {
    for (const cat of index.childrenByParent.get(class6.code) || []) {
      const amount = subtreeBalance(index, rawMonth, cat.code);
      if (amount > 0.001) cats.push({ code: cat.code, name: cat.name, amount });
    }
    cats.sort((a, b) => b.amount - a.amount);
  }
  let donutSegments = cats;
  if (cats.length > 5) {
    const rest = round2(cats.slice(5).reduce((s, c) => s + c.amount, 0));
    donutSegments = rest > 0 ? [...cats.slice(0, 5), { code: 'otros', name: 'Otros gastos', amount: rest }] : cats.slice(0, 5);
  }
  const expenseDonut = { segments: donutSegments, total: round2(donutSegments.reduce((s, c) => s + c.amount, 0)) };

  // Cobros aging split + last-30-day collections → the "Invoices" card.
  // `notDue`/`overdue` keep the two-way split the strip used; `buckets` exposes
  // the full 0–30 / 31–60 / 61–90 / +90 profile the aging bars render.
  // DSO (días de cobro) = open AR over average daily credit sales of the
  // trailing 365 days; null when sales history is too thin to be meaningful.
  const sales365 = round2((salesPostings || [])
    .filter((s) => (s.postedAt || 0) > end - 365 * DAY && (s.postedAt || 0) <= end)
    .reduce((s, p) => s + (Number(p.total) || 0), 0));
  const ar = {
    unpaid: cxc.totals.balance,
    notDue: cxc.totals.d0_30,
    overdue: round2(cxc.totals.d31_60 + cxc.totals.d61_90 + cxc.totals.d90),
    buckets: {
      d0_30: cxc.totals.d0_30, d31_60: cxc.totals.d31_60,
      d61_90: cxc.totals.d61_90, d90: cxc.totals.d90,
    },
    dso: sales365 > 1 ? Math.round(cxc.totals.balance / (sales365 / 365)) : null,
  };
  const collected30 = round2((payments || [])
    .filter((p) => p.direction === 'in' && p.partyType === 'customer' && (p.paidAt || 0) >= end - 30 * DAY)
    .reduce((s, p) => s + (Number(p.amount) || 0), 0));

  const ecfPending = (salesPostings || [])
    .filter((s) => !s.voidedAt && /^E\d{2}/.test(s.ncf || '') && s.ecfStatus !== 'sent' && s.ecfStatus !== 'accepted').length;

  const ecfSeqAlerts = resolveEcfSequenceAlerts(ecfSequences, { now: end });

  const recent = resolveJournal({ entries, lines, limit: 8 });

  return {
    cash,
    bankAccounts,
    cxcBalance: cxc.totals.balance,
    cxpBalance: cxp.totals.balance,
    overdue: cxc.totals.d90,
    ar,
    collected30,
    ingresosMonth: income.totalIncome,
    egresosMonth: round2(income.totalCosts + income.totalExpenses),
    utilidadMonth: income.netIncome,
    // The P&L bridge steps for the waterfall: ingresos → costo de ventas →
    // gastos → utilidad neta (costs/expenses split out of egresosMonth).
    pnl: {
      income: income.totalIncome, costs: income.totalCosts,
      expenses: income.totalExpenses, net: income.netIncome,
    },
    itbis,
    ecfPending,
    ecfSeqAlerts,
    monthsSeries: series,
    expenseDonut,
    cxcTop: cxc.rows.slice(0, 5),
    cxpTop: cxp.rows.slice(0, 5),
    recent,
  };
}
