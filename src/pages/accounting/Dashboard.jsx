import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet, ArrowDownCircle, ArrowUpCircle, Receipt, FileWarning,
  AlertTriangle, BookOpen, Landmark, Ship, Boxes, Percent, Gauge,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import PeriodNav, { DeltaChip } from '../../components/accounting/PeriodNav.jsx';
import SegmentBar from '../../components/accounting/SegmentBar.jsx';
import RowCards from '../../components/RowCards.jsx';
import { Donut, BarPairs, AreaChart, Legend, Sparkline, YoYColumns, BulletBar } from '../../components/charts/MiniCharts.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  resolveAccountingDashboard, resolvePeriod, resolveComparativeKpis,
  resolveSalesSegmented, resolveMonthlyComparative, resolveExpenseComparative,
  resolveImportPanel,
} from '../../core/accounting/index.js';

// Chart palette — drawn from the app's warm tokens (ink/brand) + a few accents.
// Centralized here so the incoming design system can retune the dashboard hues
// in one spot.
const C = {
  in: '#059669',       // entradas de caja (emerald-600)
  out: '#e8a76d',      // salidas de caja (brand-300)
  income: '#059669',
  expense: '#fb7185',  // rose-400
  sales: '#c96a2a',    // brand-500
  overdue: '#f43f5e',  // rose-500
  current: 'rgb(var(--ink-300))',  // ink-300 — theme-aware neutral
};
// Donut slice ramp (gastos por categoría). Vibrant series stay fixed (they read
// on either canvas); the two neutral fillers ride the ink ramp so they don't
// glare as bright grey slices in dark mode.
const DONUT = ['#c96a2a', '#e8a76d', '#059669', 'rgb(var(--ink-400))', '#f59e0b', 'rgb(var(--ink-200))'];

const SOURCE = {
  manual: 'Manual', sale: 'Venta', expense: 'Gasto', purchase: 'Compra',
  payment: 'Pago', import: 'Importación', opening: 'Apertura', payroll: 'Nómina',
  adjustment: 'Ajuste', depreciation: 'Depreciación', fx: 'Cambio', tax: 'Impuestos', gateway: 'Pasarela',
};

/**
 * Card chrome — title row with an optional right-aligned element. `to` renders
 * a navigation link (label `action`); `note` is a plain period label. They're
 * separate so a period like "junio 2026" never becomes a misleading link.
 */
function CardHead({ title, note, to, action }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <h2 className="eyebrow font-semibold text-ink-700">{title}</h2>
      {to ? (
        <Link to={to} className="text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors">{action || 'Ver →'}</Link>
      ) : note ? (
        <span className="eyebrow-xs text-ink-400">{note}</span>
      ) : null}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, tone, sub, to }) {
  const body = (
    <div className="stat-card card-pad h-full flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {Icon && (
          <span className="icon-tile tint-ink w-7 h-7 rounded-lg">
            <Icon size={14} />
          </span>
        )}
        <span className="eyebrow-xs tracking-wide text-ink-500 min-w-0 truncate">{label}</span>
      </div>
      <div className={`stat-value text-xl break-all ${tone || ''}`}>{value}</div>
      {sub && <div className="text-xs text-ink-400 break-words">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} className="block active:scale-[0.99] transition-transform min-w-0">{body}</Link> : body;
}

/** Simple proportional progress bar (P&L rows). */
function Bar({ value, max, tone }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2.5 rounded-full bg-ink-100 overflow-hidden">
      <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Resumen del negocio — the accounting home, in the QuickBooks "Business
 * overview" shape: a grid of live financial widgets (flujo de caja, gastos,
 * ganancia y pérdida, cobros, ventas, bancos) over the ledger, each linking
 * into its detail surface, then KPIs, alerts and recent asientos. Self-gates
 * on accounting/admin.
 */
export default function AccountingDashboard() {
  const { profileId, profiles } = useApp();
  const scope = profileId || 'team';

  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const entriesQ = useLiveQueryStatus(() => db.journalEntries.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.journalLines.where('profileId').equals(scope).toArray(), [scope], []);
  const salesQ = useLiveQueryStatus(() => db.salesPostings.where('profileId').equals(scope).toArray(), [scope], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const paymentsQ = useLiveQueryStatus(() => db.payments.where('profileId').equals(scope).toArray(), [scope], []);
  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const quotesQ = useLiveQueryStatus(() => db.quotes.where('profileId').equals(scope).toArray(), [scope], []);
  const ecfSeqQ = useLiveQueryStatus(() => db.ecfSequences.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded && salesQ.loaded;

  const today = useMemo(() => new Date(), []);

  // The whole panel is measured over ONE selected period (mes/trimestre/año,
  // steppable) — every widget, comparison and table re-frames with it.
  const [periodSel, setPeriodSel] = useState({ kind: 'month', ref: Date.now() });
  const period = useMemo(() => resolvePeriod(periodSel), [periodSel]);

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);
  const profileById = useMemo(() => new Map((profiles || []).map((p) => [p.id, p])), [profiles]);

  const d = useMemo(() => resolveAccountingDashboard({
    accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data,
    salesPostings: salesQ.data, purchases: purchasesQ.data, expenses: expensesQ.data,
    payments: paymentsQ.data, imports: importsQ.data, expedientes: expedientesQ.data,
    ecfSequences: ecfSeqQ.data, customersById, suppliersById,
    monthStart: period.start, monthEnd: period.end,
  }), [accountsQ.data, entriesQ.data, linesQ.data, salesQ.data, purchasesQ.data, expensesQ.data, paymentsQ.data, importsQ.data, expedientesQ.data, ecfSeqQ.data, customersById, suppliersById, period]);

  // Comparative layer: KPIs vs período anterior + vs año pasado.
  const kpis = useMemo(() => resolveComparativeKpis({
    salesPostings: salesQ.data, payments: paymentsQ.data, expenses: expensesQ.data,
    purchases: purchasesQ.data, expedientes: expedientesQ.data, imports: importsQ.data,
    accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data, period,
  }), [salesQ.data, paymentsQ.data, expensesQ.data, purchasesQ.data, expedientesQ.data, importsQ.data, accountsQ.data, entriesQ.data, linesQ.data, period]);

  const importPanel = useMemo(() => resolveImportPanel({
    expedientes: expedientesQ.data, imports: importsQ.data,
    accounts: accountsQ.data, lines: linesQ.data, period,
  }), [expedientesQ.data, importsQ.data, accountsQ.data, linesQ.data, period]);

  const expComp = useMemo(() => resolveExpenseComparative({
    expenses: expensesQ.data, accounts: accountsQ.data, period,
  }), [expensesQ.data, accountsQ.data, period]);

  const monthly = useMemo(() => resolveMonthlyComparative({
    salesPostings: salesQ.data, payments: paymentsQ.data, expenses: expensesQ.data,
    purchases: purchasesQ.data, expedientes: expedientesQ.data, imports: importsQ.data,
    months: 12, end: period.end,
  }), [salesQ.data, paymentsQ.data, expensesQ.data, purchasesQ.data, expedientesQ.data, importsQ.data, period]);

  // Word-sized trend per KPI (Tufte sparklines): 12 months from the
  // comparative series; utilidad rides the ledger's 6-month series.
  const kpiSeries = useMemo(() => ({
    ventas: monthly.map((m) => m.ventas),
    cobrado: monthly.map((m) => m.cobrado),
    gastos: monthly.map((m) => m.gastos),
    compras: monthly.map((m) => m.compras),
    importado: monthly.map((m) => m.importado),
  }), [monthly]);
  const utilidadSeries = useMemo(() => d.monthsSeries.map((m) => m.utilidad), [d.monthsSeries]);

  const [compView, setCompView] = useState('chart'); // 'chart' | 'table'

  // Segmented sales (Odoo-style group-by + free-text filter).
  const [groupBy, setGroupBy] = useState('customer');
  const [segQuery, setSegQuery] = useState('');
  const segmented = useMemo(() => resolveSalesSegmented({
    salesPostings: salesQ.data, quotes: quotesQ.data, customersById, profileById,
    start: period.start, end: period.end, groupBy, query: segQuery,
  }), [salesQ.data, quotesQ.data, customersById, profileById, period, groupBy, segQuery]);

  const monthLabel = period.label;
  const ventasKpi = kpis.find((k) => k.key === 'ventas');
  const pnlMax = Math.max(d.ingresosMonth, d.egresosMonth, 1);
  const arTotal = Math.max(d.ar.unpaid, 1);
  const segLabel = { customer: 'Cliente', seller: 'Vendedor', canal: 'Canal', ecfType: 'Comprobante' }[groupBy];

  return (
    <AccountingGate title="Resumen del negocio">
      <PageHeader title="Resumen del negocio" subtitle={`Posición al ${formatDate(today.getTime())}`}
        actions={<PeriodNav kind={periodSel.kind} refMs={periodSel.ref} onChange={setPeriodSel} />} />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4 min-w-0">
          {/* Comparative KPI scorecards — the monitor layer: the period's
              headline figures, each against the previous period AND the same
              period last year. */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 min-w-0">
            {kpis.map((k) => (
              <div key={k.key} className="stat-card p-3.5 min-w-0">
                <div className="eyebrow-xs text-ink-500 truncate mb-1.5">{k.label}</div>
                <div className={`stat-value text-xl whitespace-nowrap ${k.key === 'utilidad' ? (k.current >= 0 ? 'text-emerald-700' : 'text-rose-700') : ''}`}>
                  {formatDop(k.current)}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <DeltaChip delta={k.deltaPrev} vs={period.prev.label} />
                  <span className="text-[10px] text-ink-300 uppercase tracking-wide">vs ant.</span>
                  <DeltaChip delta={k.deltaYoy} vs={period.yoy.label} />
                  <span className="text-[10px] text-ink-300 uppercase tracking-wide">vs año</span>
                </div>
                {(() => {
                  const series = k.key === 'utilidad' ? utilidadSeries : kpiSeries[k.key];
                  return series?.some((v) => v !== 0) ? (
                    <div className="mt-2 -mb-0.5"><Sparkline points={series} color={C.current} /></div>
                  ) : null;
                })()}
              </div>
            ))}
          </div>
          {/* Urgent flags float to the top. */}
          {(d.ecfPending > 0 || d.overdue > 0 || d.ecfSeqAlerts.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {d.ecfSeqAlerts.map((a) => (
                <Link key={a.type} to="/accounting/ecf" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-rose-50 text-rose-800 border border-rose-200 font-medium shadow-xs transition-shadow hover:shadow-sm">
                  <FileWarning size={14} className="shrink-0" />
                  {a.kind === 'none' && `Sin secuencia e-NCF utilizable para ${a.label} — autoriza un rango`}
                  {a.kind === 'low' && `Quedan ${a.remaining} e-NCF de ${a.label}`}
                  {a.kind === 'expiring' && `La secuencia e-NCF de ${a.label} vence el ${formatDate(a.expiresAt)}`}
                </Link>
              ))}
              {d.ecfPending > 0 && (
                <Link to="/accounting/facturacion" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-amber-50 text-amber-800 border border-amber-200 font-medium shadow-xs transition-shadow hover:shadow-sm">
                  <FileWarning size={14} className="shrink-0" /> {d.ecfPending} e-CF pendientes de transmitir a la DGII
                </Link>
              )}
              {d.overdue > 0 && (
                <Link to="/accounting/cuentas" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-rose-50 text-rose-800 border border-rose-200 font-medium shadow-xs transition-shadow hover:shadow-sm">
                  <AlertTriangle size={14} className="shrink-0" /> {formatDop(d.overdue)} en cuentas vencidas (+90 días)
                </Link>
              )}
            </div>
          )}

          {/* Business-overview widgets — row 1: flujo · gastos · P&L. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 min-w-0">
            {/* Flujo de caja */}
            <div className="card p-4 flex flex-col">
              <CardHead title="Flujo de caja" to="/accounting/ledger" action="Ver mayor →" />
              <div className="font-display text-2xl font-semibold tabular-nums text-ink-900">{formatDop(d.cash)}</div>
              <div className="text-xs text-ink-400 mb-3">Saldo en caja y bancos</div>
              <div className="mt-auto">
                <BarPairs
                  data={d.monthsSeries.map((m) => ({ label: m.label, a: m.cashIn, b: m.cashOut }))}
                  colors={[C.in, C.out]} format={formatDop}
                />
                <Legend items={[{ label: 'Entradas', color: C.in }, { label: 'Salidas', color: C.out }]} />
              </div>
            </div>

            {/* Gastos (donut por categoría) */}
            <div className="card p-4">
              <CardHead title="Gastos" note={monthLabel} />
              {d.expenseDonut.total <= 0 ? (
                <div className="flex items-center justify-center h-[148px] text-sm text-ink-400">Sin gastos este mes.</div>
              ) : (
                <div className="flex items-center gap-3 min-w-0">
                  <Donut size={112} thickness={14}
                    segments={d.expenseDonut.segments.map((s, i) => ({ value: s.amount, color: DONUT[i % DONUT.length] }))}>
                    <div className="eyebrow-xs text-ink-400">Total</div>
                    <div className="text-xs font-semibold tabular-nums">{formatDop(d.expenseDonut.total)}</div>
                  </Donut>
                  <ul className="flex-1 min-w-0 space-y-1.5">
                    {d.expenseDonut.segments.map((s, i) => (
                      <li key={s.code} className="flex items-center gap-2 text-xs min-w-0">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: DONUT[i % DONUT.length] }} />
                        <span className="truncate text-ink-600 flex-1 min-w-0">{s.name}</span>
                        <span className="tabular-nums font-medium text-ink-700 shrink-0">{formatDop(s.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Ganancia y pérdida */}
            <div className="card p-4 flex flex-col">
              <CardHead title="Ganancia y pérdida" note={monthLabel} />
              <div className={`font-display text-2xl font-semibold tabular-nums ${d.utilidadMonth >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {formatDop(d.utilidadMonth)}
              </div>
              <div className="text-xs text-ink-400 mb-3">Utilidad neta de {monthLabel}</div>
              <div className="space-y-3 mt-auto">
                <div>
                  <div className="flex items-center justify-between gap-2 text-sm mb-1 flex-wrap"><span className="text-ink-500">Ingresos</span><span className="tabular-nums font-medium shrink-0">{formatDop(d.ingresosMonth)}</span></div>
                  <Bar value={d.ingresosMonth} max={pnlMax} tone="bg-emerald-500" />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 text-sm mb-1 flex-wrap"><span className="text-ink-500">Egresos</span><span className="tabular-nums font-medium shrink-0">{formatDop(d.egresosMonth)}</span></div>
                  <Bar value={d.egresosMonth} max={pnlMax} tone="bg-rose-400" />
                </div>
              </div>
            </div>
          </div>

          {/* Row 2: cobros · ventas · bancos. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 min-w-0">
            {/* Cuentas por cobrar */}
            <div className="card p-4 flex flex-col">
              <CardHead title="Cuentas por cobrar" to="/accounting/cuentas" action="Ver cuentas →" />
              <div className="font-display text-2xl font-semibold tabular-nums text-ink-900">{formatDop(d.ar.unpaid)}</div>
              <div className="text-xs text-ink-400 mb-3">Sin cobrar</div>
              <div className="mt-auto">
                <div className="h-2.5 rounded-full overflow-hidden flex bg-ink-100">
                  <div className="h-full" style={{ width: `${(d.ar.overdue / arTotal) * 100}%`, backgroundColor: C.overdue }} />
                  <div className="h-full" style={{ width: `${(d.ar.notDue / arTotal) * 100}%`, backgroundColor: C.current }} />
                </div>
                <div className="flex flex-wrap justify-between text-xs mt-2 gap-1">
                  <span className="text-rose-600">Vencido {formatDop(d.ar.overdue)}</span>
                  <span className="text-ink-500">Por vencer {formatDop(d.ar.notDue)}</span>
                </div>
                <div className="flex justify-between items-center text-sm mt-3 pt-3 border-t border-ink-100">
                  <span className="text-ink-500">Cobrado (30 días)</span>
                  <span className="tabular-nums font-medium text-emerald-700">{formatDop(d.collected30)}</span>
                </div>
              </div>
            </div>

            {/* Ventas */}
            <div className="card p-4 flex flex-col">
              <CardHead title="Ventas" note="6 meses" />
              <div className="font-display text-2xl font-semibold tabular-nums text-ink-900">{formatDop(ventasKpi?.current || 0)}</div>
              <div className="text-xs text-ink-400 mb-3">Facturado en {monthLabel}</div>
              <div className="mt-auto">
                <AreaChart points={d.monthsSeries.map((m) => ({ label: m.label, value: m.sales }))} color={C.sales} />
              </div>
            </div>

            {/* Cuentas de banco */}
            <div className="card p-4 flex flex-col">
              <CardHead title="Cuentas de banco" to="/accounting/ledger" action="Ver mayor →" />
              {d.bankAccounts.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-sm text-ink-400 py-6">Sin movimientos de efectivo aún.</div>
              ) : (
                <ul className="space-y-2 min-w-0">
                  {d.bankAccounts.slice(0, 5).map((b) => (
                    <li key={b.code} className="flex items-center gap-2.5 py-1 rounded-lg hover:bg-ink-50/60 transition-colors -mx-1 px-1 min-w-0">
                      <span className="w-8 h-8 rounded-lg bg-ink-100 ring-1 ring-inset ring-black/5 flex items-center justify-center text-ink-500 shrink-0"><Landmark size={14} /></span>
                      <span className="flex-1 min-w-0 truncate text-sm text-ink-700">{b.name}</span>
                      <span className="tabular-nums font-medium text-sm text-ink-900 shrink-0">{formatDop(b.balance)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-between items-center text-sm mt-3 pt-3 border-t border-ink-100">
                <span className="text-ink-500 font-medium">Total</span>
                <span className="tabular-nums font-semibold text-ink-900">{formatDop(d.cash)}</span>
              </div>
            </div>
          </div>

          {/* Compact KPI strip. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 min-w-0">
            <Kpi icon={Wallet} label="Efectivo y bancos" value={formatDop(d.cash)} to="/accounting/ledger" />
            <Kpi icon={ArrowDownCircle} label="Por cobrar" value={formatDop(d.cxcBalance)} to="/accounting/cuentas"
              sub={d.overdue > 0 ? `${formatDop(d.overdue)} vencido +90` : 'al día'} tone={d.overdue > 0 ? 'text-rose-700' : ''} />
            <Kpi icon={ArrowUpCircle} label="Por pagar" value={formatDop(d.cxpBalance)} to="/accounting/cuentas" />
            <Kpi icon={Receipt} label="ITBIS del período"
              value={formatDop(d.itbis.aPagar > 0 ? d.itbis.aPagar : d.itbis.aFavor)}
              sub={d.itbis.aPagar > 0 ? 'a pagar' : 'a favor'} to="/accounting/facturacion" />
          </div>

          <div className="section-rule"><span>Análisis del período</span></div>

          {/* Analysis layer — importaciones 360° + where spending moved. */}
          <div className="grid lg:grid-cols-2 gap-4 min-w-0">
            <div className="card p-4 min-w-0">
              <CardHead title="Importaciones" to="/accounting/importaciones" action="Ver expedientes →" />
              <div className="grid grid-cols-2 gap-3">
                {[
                  { tint: 'tint-sky', icon: Ship, label: 'En tránsito', value: formatDop(importPanel.inTransit), sub: 'mercancía en el agua' },
                  { tint: 'tint-brand', icon: Boxes, label: `Importado · ${monthLabel}`, value: formatDop(importPanel.landed), delta: true },
                  { tint: 'tint-emerald', icon: Percent, label: 'ITBIS aduanal', value: formatDop(importPanel.itbisAduanal), sub: 'crédito fiscal del período' },
                  { tint: 'tint-ink', icon: Gauge, label: 'Factor de costo', value: importPanel.landedFactor != null ? `× ${importPanel.landedFactor.toFixed(2)}` : '—', sub: `${importPanel.expedientesCount} expediente${importPanel.expedientesCount === 1 ? '' : 's'} · destino ÷ CIF` },
                ].map((it) => (
                  <div key={it.label} className="surface-subtle p-3 min-w-0 flex items-start gap-2.5">
                    <span className={`icon-tile ${it.tint}`}><it.icon size={14} /></span>
                    <div className="min-w-0">
                      <div className="eyebrow-xs text-ink-500 mb-0.5 truncate">{it.label}</div>
                      <div className="stat-value text-lg whitespace-nowrap">{it.value}</div>
                      {it.delta ? (
                        <div className="flex items-center gap-1.5 mt-0.5"><DeltaChip delta={importPanel.landedDelta} vs={period.prev.label} /><span className="text-[10px] text-ink-300 uppercase tracking-wide">vs ant.</span></div>
                      ) : (
                        <div className="text-[11px] text-ink-400 truncate">{it.sub}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card overflow-hidden min-w-0">
              <div className="card-header">
                <h2 className="eyebrow font-semibold text-ink-700">Gastos por categoría · {monthLabel}</h2>
                <Link to="/accounting/expenses" className="text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors">Ver gastos →</Link>
              </div>
              {expComp.length === 0 ? (
                <p className="text-sm text-ink-400 px-4 py-6 text-center">Sin gastos en el período.</p>
              ) : (
                <div className="px-4 py-3">
                  {/* Bullet bars: one shared scale; the tick marks the previous
                      period, so "above/below where it was" reads without a
                      second column of numbers. */}
                  <div className="space-y-3">
                    {(() => {
                      const shown = expComp.slice(0, 7);
                      const max = Math.max(...shown.flatMap((x) => [x.current, x.previous]));
                      return shown.map((r) => (
                        <div key={r.code} className="min-w-0" title={`${r.name}: ${formatDop(r.current)} · ${period.prev.label} ${formatDop(r.previous)}`}>
                          <div className="flex items-baseline justify-between gap-2 text-sm mb-1 min-w-0">
                            <span className="truncate text-ink-700 min-w-0">{r.name}</span>
                            <span className="shrink-0 inline-flex items-baseline gap-2">
                              <span className="tabular-nums font-medium">{formatDop(r.current)}</span>
                              <DeltaChip delta={r.delta} vs={period.prev.label} />
                            </span>
                          </div>
                          <BulletBar value={r.current} marker={r.previous} max={max} color={C.sales} />
                        </div>
                      ));
                    })()}
                  </div>
                  <p className="text-[11px] text-ink-400 mt-3">barra = {monthLabel} · marca = {period.prev.label}</p>
                </div>
              )}
            </div>
          </div>

          <div className="section-rule"><span>Detalle</span></div>

          {/* Drill layer — segmented sales (Odoo-style group-by). */}
          <div className="card p-4 min-w-0">
            <CardHead title={`Ventas por ${segLabel.toLowerCase()} · ${monthLabel}`} to="/accounting/facturacion" action="Ver facturación →" />
            <SegmentBar groupBy={groupBy} onGroupBy={setGroupBy} query={segQuery} onQuery={setSegQuery}
              options={[
                { key: 'customer', label: 'Cliente' }, { key: 'seller', label: 'Vendedor' },
                { key: 'canal', label: 'Canal' }, { key: 'ecfType', label: 'Comprobante' },
              ]} />
            {segmented.rows.length === 0 ? (
              <p className="text-sm text-ink-400 py-6 text-center">Sin ventas que coincidan en el período.</p>
            ) : (
              <>
              <RowCards
                rows={segmented.rows.slice(0, 10).map((s) => ({
                  key: s.key,
                  title: s.label,
                  right: formatDop(s.total),
                  kv: [
                    ['Ventas', s.count],
                    ['% del total', `${Math.round(s.share * 100)}%`],
                    ['Base', formatDop(s.base)],
                    ['ITBIS', formatDop(s.itbis)],
                  ],
                }))}
                footer={[
                  ['Segmentos', segmented.rows.length],
                  ['Ventas', segmented.totals.count],
                  ['Base', formatDop(segmented.totals.base)],
                  ['Total', formatDop(segmented.totals.total)],
                ]}
              />
              <div className="hidden md:block overflow-x-auto">
                <table className="table">
                  <thead><tr><th>{segLabel}</th><th className="text-right">Ventas</th><th className="text-right">Base</th><th className="text-right">ITBIS</th><th className="text-right">Total</th><th className="text-right">% del total</th></tr></thead>
                  <tbody>
                    {segmented.rows.slice(0, 10).map((s) => (
                      <tr key={s.key} className="hover:bg-ink-50 transition-colors">
                        <td className="text-ink-700 min-w-0 truncate max-w-56">{s.label}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{s.count}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(s.base)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(s.itbis)}</td>
                        <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(s.total)}</td>
                        <td className="text-right tabular-nums text-ink-500 whitespace-nowrap">{Math.round(s.share * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ink-200 font-semibold">
                      <td>{segmented.rows.length} segmentos</td>
                      <td className="text-right tabular-nums">{segmented.totals.count}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(segmented.totals.base)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(segmented.totals.itbis)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(segmented.totals.total)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              </>
            )}
          </div>

          {/* Comparativo mensual — the YoY ventas chart (this year solid over
              last year's ghost) + small-multiple sparklines for the companion
              metrics; the full table stays one toggle away. */}
          <div className="card overflow-hidden min-w-0">
            <div className="card-header">
              <h2 className="eyebrow font-semibold text-ink-700">Comparativo mensual · últimos 12 meses</h2>
              <div className="flex gap-1">
                <button type="button" onClick={() => setCompView('chart')}
                  className={`btn text-xs ${compView === 'chart' ? 'tab-pill-active' : 'tab-pill'}`}>Gráfico</button>
                <button type="button" onClick={() => setCompView('table')}
                  className={`btn text-xs ${compView === 'table' ? 'tab-pill-active' : 'tab-pill'}`}>Tabla</button>
              </div>
            </div>
            {compView === 'chart' ? (
              <div className="p-4 space-y-4">
                <YoYColumns
                  data={monthly.map((m) => ({ label: m.label, value: m.ventas, prev: m.ventasYoy }))}
                  color={C.sales} format={formatDop} />
                <Legend items={[
                  { label: 'Ventas facturadas', color: C.sales },
                  { label: 'Mismo mes, año anterior', color: 'rgb(var(--ink-100))' },
                ]} />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-ink-100">
                  {[
                    { key: 'cobrado', label: 'Cobrado', color: C.in },
                    { key: 'gastos', label: 'Gastos', color: C.expense },
                    { key: 'compras', label: 'Compras', color: 'rgb(var(--ink-400))' },
                    { key: 'importado', label: 'Importado', color: C.out },
                  ].map((m) => {
                    const last = monthly[monthly.length - 1];
                    return (
                      <div key={m.key} className="min-w-0">
                        <div className="flex items-baseline justify-between gap-2 mb-1">
                          <span className="eyebrow-xs text-ink-500 truncate">{m.label}</span>
                          <span className="text-sm font-semibold tabular-nums whitespace-nowrap">{formatDop(last?.[m.key] || 0)}</span>
                        </div>
                        <Sparkline points={monthly.map((row) => row[m.key])} color={m.color} height={30} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <>
              <RowCards inCard
                rows={monthly.map((m) => ({
                  key: m.key,
                  title: <span className="capitalize">{m.label}</span>,
                  right: formatDop(m.ventas),
                  sub: <>Año anterior <span className="tabular-nums">{formatDop(m.ventasYoy)}</span> <DeltaChip delta={m.deltaYoy} /></>,
                  kv: [
                    ['Cobrado', formatDop(m.cobrado)],
                    ['Gastos', formatDop(m.gastos)],
                    ['Compras', formatDop(m.compras)],
                    ['Importado', formatDop(m.importado)],
                  ],
                }))}
              />
              <div className="hidden md:block overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Mes</th><th className="text-right">Ventas</th><th className="text-right">Año anterior</th><th className="text-right">Δ año</th><th className="text-right">Cobrado</th><th className="text-right">Gastos</th><th className="text-right">Compras</th><th className="text-right">Importado</th></tr></thead>
                  <tbody>
                    {monthly.map((m) => (
                      <tr key={m.key} className="hover:bg-ink-50 transition-colors">
                        <td className="text-ink-700 whitespace-nowrap capitalize">{m.label}</td>
                        <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(m.ventas)}</td>
                        <td className="text-right tabular-nums text-ink-500 whitespace-nowrap">{formatDop(m.ventasYoy)}</td>
                        <td className="text-right whitespace-nowrap"><DeltaChip delta={m.deltaYoy} /></td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(m.cobrado)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(m.gastos)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(m.compras)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(m.importado)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>

          {/* Top debtors / creditors. */}
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="card overflow-hidden">
              <div className="card-header">
                <h2 className="eyebrow font-semibold text-ink-700">Mayores deudores</h2>
                <Link to="/accounting/cuentas" className="text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors">Ver todo →</Link>
              </div>
              {d.cxcTop.length === 0 ? (
                <p className="text-sm text-ink-400 px-4 py-6 text-center">Nada por cobrar.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {d.cxcTop.map((r) => (
                    <li key={r.partyId} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:bg-ink-50/60 px-4 transition-colors min-w-0">
                      <span className="truncate text-ink-700 min-w-0">{r.party?.name || '—'}</span>
                      <span className="tabular-nums font-semibold text-ink-900 shrink-0">{formatDop(r.balance)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="card overflow-hidden">
              <div className="card-header">
                <h2 className="eyebrow font-semibold text-ink-700">Mayores acreedores</h2>
                <Link to="/accounting/cuentas" className="text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors">Ver todo →</Link>
              </div>
              {d.cxpTop.length === 0 ? (
                <p className="text-sm text-ink-400 px-4 py-6 text-center">Nada por pagar.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {d.cxpTop.map((r) => (
                    <li key={r.partyId} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:bg-ink-50/60 px-4 transition-colors min-w-0">
                      <span className="truncate text-ink-700 min-w-0">{r.party?.name || '—'}</span>
                      <span className="tabular-nums font-semibold text-ink-900 shrink-0">{formatDop(r.balance)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Recent asientos. */}
          <div className="card overflow-hidden">
            <div className="card-header">
              <h2 className="inline-flex items-center gap-1.5 eyebrow font-semibold text-ink-700"><BookOpen size={14} /> Asientos recientes</h2>
              <Link to="/accounting/ledger" className="text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors">Ir al diario →</Link>
            </div>
            {d.recent.length === 0 ? (
              <p className="text-sm text-ink-400 px-4 py-6">Aún no hay asientos.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="w-24">Fecha</th>
                      <th>Origen / Detalle</th>
                      <th className="text-right">Débito</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.recent.map(({ entry, debit }) => (
                      <tr key={entry.id} className="hover:bg-ink-50 transition-colors">
                        <td className="text-ink-500 whitespace-nowrap tabular-nums">{formatDate(entry.postedAt)}</td>
                        <td className="min-w-0">
                          <span className="chip bg-ink-100 text-ink-600 mr-2">{SOURCE[entry.source] || entry.source}</span>
                          <span className="text-ink-700 break-words">{entry.memo || '—'}</span>
                        </td>
                        <td className="text-right tabular-nums font-semibold text-ink-900 whitespace-nowrap">{formatDop(debit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </AccountingGate>
  );
}
