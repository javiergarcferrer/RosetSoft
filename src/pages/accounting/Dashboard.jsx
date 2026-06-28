import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Wallet, ArrowDownCircle, ArrowUpCircle, Receipt,
  BookOpen, Landmark, Ship, Boxes, Percent, Gauge,
  FileText, ShoppingCart, Lock, CheckCircle2, ListChecks,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import PeriodNav, { DeltaChip } from '../../components/accounting/PeriodNav.jsx';
import { ActionList } from '../../components/accounting/ActionCenter.jsx';
import SegmentBar from '../../components/accounting/SegmentBar.jsx';
import RowCards from '../../components/RowCards.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import { Donut, BarPairs, AreaChart, Legend, Sparkline, YoYColumns, BulletBar, Waterfall, AgingBars, CountUp } from '../../components/charts/MiniCharts.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  resolveAccountingDashboard, resolveAccountingCockpit, resolvePeriod, resolveComparativeKpis,
  resolveSalesSegmented, resolveMonthlyComparative, resolveExpenseComparative,
  resolveImportPanel,
} from '../../core/accounting/index.js';

// Cockpit quick-create actions (QBO "+ Nuevo"): the daily create flows, one tap.
const QUICK_ACTIONS = [
  { label: 'Factura', to: '/accounting/facturacion', icon: FileText },
  { label: 'Cobro', to: '/accounting/cuentas?new=in', icon: ArrowDownCircle },
  { label: 'Pago', to: '/accounting/cuentas?new=out', icon: ArrowUpCircle },
  { label: 'Gasto', to: '/accounting/compras-gastos/nuevo?tipo=gasto', icon: Receipt },
  { label: 'Compra', to: '/accounting/compras-gastos/nuevo?tipo=mercancia', icon: ShoppingCart },
  { label: 'Expediente', to: '/accounting/importaciones/nuevo', icon: Ship },
  { label: 'Asiento', to: '/accounting/ledger?new=1', icon: BookOpen },
];
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
// Receivables aging ramp — neutral while current, warming into rose as the
// debt ages, so the +90 tail reads as the alarming one.
const AGING = [
  { key: 'd0_30', label: '0–30', tone: 'rgb(var(--ink-300))' },
  { key: 'd31_60', label: '31–60', tone: '#f59e0b' },
  { key: 'd61_90', label: '61–90', tone: '#e8a76d' },
  { key: 'd90', label: '+90', tone: '#f43f5e' },
];

const SOURCE = {
  manual: 'Manual', sale: 'Venta', expense: 'Gasto', purchase: 'Compra',
  payment: 'Pago', import: 'Importación', opening: 'Apertura', payroll: 'Nómina',
  adjustment: 'Ajuste', depreciation: 'Depreciación', fx: 'Cambio', tax: 'Impuestos', gateway: 'Pasarela',
};

// Segmented-sales table columns (Shopify "edit columns"). The segment column is
// the fixed identity anchor (`canHide: false`) — its header is dynamic (Cliente
// / Vendedor / Canal / Comprobante) so it's not offered in the menu; the metric
// columns toggle. Each `cell` is a pure render off the per-row `ctx`.
const SEGMENT_COLUMNS = [
  {
    key: 'segment', label: 'Segmento', canHide: false,
    tdClass: 'text-ink-700 min-w-0 truncate max-w-56',
    cell: ({ s }) => s.label,
  },
  {
    key: 'count', label: 'Ventas',
    thClass: 'text-right', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ s }) => s.count,
  },
  {
    key: 'base', label: 'Base',
    thClass: 'text-right', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ s }) => formatDop(s.base),
  },
  {
    key: 'itbis', label: 'ITBIS',
    thClass: 'text-right', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ s }) => formatDop(s.itbis),
  },
  {
    key: 'total', label: 'Total',
    thClass: 'text-right', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ s }) => formatDop(s.total),
  },
  {
    key: 'share', label: '% del total',
    thClass: 'text-right', tdClass: 'text-right tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ s }) => `${Math.round(s.share * 100)}%`,
  },
];
const SEGMENT_DEFAULT = { count: true, base: true, itbis: true, total: true, share: true };

// Comparativo-mensual table columns. Mes is the fixed anchor; the rest toggle.
const COMP_COLUMNS = [
  {
    key: 'month', label: 'Mes', canHide: false,
    tdClass: 'text-ink-700 whitespace-nowrap capitalize',
    cell: ({ m }) => m.label,
  },
  {
    key: 'ventas', label: 'Ventas',
    thClass: 'text-right', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ m }) => formatDop(m.ventas),
  },
  {
    key: 'ventasYoy', label: 'Año anterior',
    thClass: 'text-right', tdClass: 'text-right tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ m }) => formatDop(m.ventasYoy),
  },
  {
    key: 'deltaYoy', label: 'Δ año',
    thClass: 'text-right', tdClass: 'text-right whitespace-nowrap',
    cell: ({ m }) => <DeltaChip delta={m.deltaYoy} />,
  },
  {
    key: 'cobrado', label: 'Cobrado',
    thClass: 'text-right', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ m }) => formatDop(m.cobrado),
  },
  {
    key: 'gastos', label: 'Gastos',
    thClass: 'text-right', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ m }) => formatDop(m.gastos),
  },
  {
    key: 'compras', label: 'Compras',
    thClass: 'text-right', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ m }) => formatDop(m.compras),
  },
  {
    key: 'importado', label: 'Importado',
    thClass: 'text-right', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ m }) => formatDop(m.importado),
  },
];
const COMP_DEFAULT = { ventas: true, ventasYoy: true, deltaYoy: true, cobrado: true, gastos: true, compras: true, importado: true };

// Asientos recientes table columns. Fecha is the fixed anchor; origen/detalle
// and débito toggle.
const RECENT_COLUMNS = [
  {
    key: 'date', label: 'Fecha', canHide: false,
    thClass: 'w-24', tdClass: 'text-ink-500 whitespace-nowrap tabular-nums',
    cell: ({ entry }) => formatDate(entry.postedAt),
  },
  {
    key: 'memo', label: 'Origen / Detalle',
    tdClass: 'min-w-0',
    cell: ({ entry }) => (
      <>
        <span className="chip bg-ink-100 text-ink-600 mr-2">{SOURCE[entry.source] || entry.source}</span>
        <span className="text-ink-700 break-words">{entry.memo || '—'}</span>
      </>
    ),
  },
  {
    key: 'debit', label: 'Débito',
    thClass: 'text-right', tdClass: 'text-right tabular-nums font-semibold text-ink-900 whitespace-nowrap',
    cell: ({ debit }) => formatDop(debit),
  },
];
const RECENT_DEFAULT = { memo: true, debit: true };

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

/** One stage of the trade-cycle pipeline (importación → venta → cobro). Each
 *  links to its detail surface; the value comes straight from already-resolved
 *  VM data, so this band adds NO logic — only synthesis of figures that
 *  otherwise sit scattered across the widgets below. */
function CycleStage({ icon: Icon, tint, label, value, sub, to }) {
  return (
    <Link to={to} className="shrink-0 grow snap-start basis-[8.5rem] min-w-[8.5rem] surface-subtle p-3 hover:shadow-xs active:scale-[0.99] transition-all">
      <span className={`icon-tile ${tint} mb-2`}><Icon size={14} /></span>
      <div className="eyebrow-xs text-ink-500 truncate">{label}</div>
      <div className="stat-value text-base whitespace-nowrap">{value}</div>
      <div className="text-[11px] text-ink-400 truncate">{sub}</div>
    </Link>
  );
}
/** The → connecting two pipeline stages. */
function CycleArrow() {
  return <span aria-hidden className="self-center shrink-0 text-ink-300 text-lg select-none">→</span>;
}

/** The human label for one cockpit action (the VM returns structured data; the
 *  View owns the money/date formatting + the copy). */
/**
 * Resumen del negocio — the accounting home, in the QuickBooks "Business
 * overview" shape: a grid of live financial widgets (flujo de caja, gastos,
 * ganancia y pérdida, cobros, ventas, bancos) over the ledger, each linking
 * into its detail surface, then KPIs, alerts and recent asientos. Self-gates
 * on accounting/admin.
 */
export default function AccountingDashboard() {
  const { profileId, profiles, settings } = useApp();
  const navigate = useNavigate();
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
  const periodsQ = useLiveQueryStatus(() => db.fiscalPeriods.where('profileId').equals(scope).toArray(), [scope], []);
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

  // Cockpit — "as of today", independent of the period selector (deadlines,
  // period-close and the action center don't re-frame when you step the period).
  const cockpit = useMemo(() => resolveAccountingCockpit({
    settings, fiscalPeriods: periodsQ.data, quotes: quotesQ.data, salesPostings: salesQ.data,
    payments: paymentsQ.data, purchases: purchasesQ.data, expenses: expensesQ.data,
    customersById, suppliersById, ecfSequences: ecfSeqQ.data, now: today.getTime(),
  }), [settings, periodsQ.data, quotesQ.data, salesQ.data, paymentsQ.data, purchasesQ.data, expensesQ.data, customersById, suppliersById, ecfSeqQ.data, today]);

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
  // Net cash movement across the visible window — does the saldo grow or bleed?
  const cashNet = d.monthsSeries.reduce((s, m) => s + (m.cashIn - m.cashOut), 0);
  const segLabel = { customer: 'Cliente', seller: 'Vendedor', canal: 'Canal', ecfType: 'Comprobante' }[groupBy];

  // Column visibility (Shopify "edit columns"), persisted per browser, one key
  // per desktop record table on this page.
  const segCols = useColumns(SEGMENT_COLUMNS, SEGMENT_DEFAULT, 'rs.dashboard.segment.cols.v1');
  const compCols = useColumns(COMP_COLUMNS, COMP_DEFAULT, 'rs.dashboard.comparativo.cols.v1');
  const recentCols = useColumns(RECENT_COLUMNS, RECENT_DEFAULT, 'rs.dashboard.asientos.cols.v1');
  // Drag-to-resize widths (persisted) for the same visible columns, one key per
  // desktop record table on this page.
  const segW = useColumnWidths(segCols.cols, 'rs.dashboard.segment.widths.v1');
  const compW = useColumnWidths(compCols.cols, 'rs.dashboard.comparativo.widths.v1');
  const recentW = useColumnWidths(recentCols.cols, 'rs.dashboard.asientos.widths.v1');

  return (
    <AccountingGate title="Resumen del negocio">
      <PageHeader title="Resumen del negocio" subtitle={`Posición al ${formatDate(today.getTime())}`}
        actions={<PeriodNav kind={periodSel.kind} refMs={periodSel.ref} onChange={setPeriodSel} />} />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4 min-w-0">
          {/* Cockpit — the command center, always "as of today": one-tap quick
              create, the prioritized action center (what needs doing now), and
              the fiscal calendar + period-close status. */}
          <div className="space-y-3">
            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {QUICK_ACTIONS.map((a) => (
                <Link key={a.label} to={a.to}
                  className="inline-flex items-center gap-2 shrink-0 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm font-medium text-ink-700 shadow-xs hover:border-ink-300 hover:bg-ink-50 active:scale-[0.99] transition-all">
                  <span className="icon-tile tint-ink w-6 h-6 rounded-md"><a.icon size={13} /></span>{a.label}
                </Link>
              ))}
            </div>

            <div className="grid lg:grid-cols-3 gap-3 min-w-0">
              {/* Action center */}
              <div className="card p-4 lg:col-span-2 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h2 className="eyebrow font-semibold text-ink-700 inline-flex items-center gap-1.5"><ListChecks size={14} /> Pendientes</h2>
                  {cockpit.counts.danger > 0 && <span className="chip bg-rose-100 text-rose-700">{cockpit.counts.danger} urgente{cockpit.counts.danger === 1 ? '' : 's'}</span>}
                </div>
                {cockpit.actions.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-emerald-700 py-8"><CheckCircle2 size={16} /> Todo al día — sin pendientes.</div>
                ) : (
                  <ActionList actions={cockpit.actions} />
                )}
              </div>

              {/* Fiscal calendar + period close */}
              <div className="card p-4 min-w-0 flex flex-col">
                <CardHead title="Calendario fiscal" to="/accounting/impuestos" action="DGII →" />
                <ul className="space-y-1">
                  {cockpit.deadlines.map((dl) => (
                    <li key={dl.code}>
                      <Link to={dl.to} className="flex items-center gap-2.5 -mx-1 px-1 py-1.5 rounded-lg hover:bg-ink-50/60 transition-colors min-w-0">
                        <span className={`w-10 text-center shrink-0 tabular-nums font-semibold text-sm ${dl.severity === 'danger' ? 'text-rose-600' : dl.severity === 'warn' ? 'text-amber-600' : 'text-ink-400'}`}>{dl.daysLeft}d</span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm text-ink-700 truncate">{dl.label}</span>
                          <span className="block text-[11px] text-ink-400">{dl.periodLabel}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-3 border-t border-ink-100 flex items-center justify-between gap-2 text-sm">
                  <span className="text-ink-500 inline-flex items-center gap-1.5 shrink-0"><Lock size={13} /> Cierre</span>
                  {cockpit.periodClose.prevClosed ? (
                    <span className="text-emerald-700 inline-flex items-center gap-1 min-w-0 truncate"><CheckCircle2 size={13} className="shrink-0" /> {cockpit.periodClose.prevLabel} cerrado</span>
                  ) : (
                    <Link to="/accounting/periodos" className="text-amber-700 font-medium hover:underline truncate">Cerrar {cockpit.periodClose.prevLabel} →</Link>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Trade-cycle pipeline — the business in one line: merchandise in the
              water → landed cost → sold → still owed. Synthesizes figures that
              otherwise sit scattered across the widgets below, so the
              import→venta→cobro flow (our whole purpose) reads at a glance.
              Pure synthesis of already-resolved VM data. */}
          <div className="card p-4 min-w-0">
            <CardHead title="Del contenedor a la venta" />
            <div className="flex items-stretch gap-1.5 overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <CycleStage icon={Ship} tint="tint-sky" label="En tránsito" value={formatDop(importPanel.inTransit)} sub="en el agua" to="/accounting/importaciones" />
              <CycleArrow />
              <CycleStage icon={Boxes} tint="tint-brand" label="Importado" value={formatDop(importPanel.landed)} sub={`destino · ${monthLabel}`} to="/accounting/importaciones" />
              <CycleArrow />
              <CycleStage icon={Receipt} tint="tint-emerald" label="Ventas" value={formatDop(ventasKpi?.current || 0)} sub={`facturado · ${monthLabel}`} to="/accounting/facturacion" />
              <CycleArrow />
              <CycleStage icon={ArrowDownCircle} tint="tint-ink" label="Por cobrar" value={formatDop(d.ar.unpaid)} sub="sin cobrar" to="/accounting/cuentas" />
            </div>
          </div>

          <div className="section-rule"><span>Posición del negocio</span></div>

          {/* Comparative KPI scorecards — the monitor layer: the period's
              headline figures, each against the previous period AND the same
              period last year. */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 min-w-0">
            {kpis.map((k) => (
              <div key={k.key} className="stat-card p-3.5 min-w-0">
                <div className="eyebrow-xs text-ink-500 truncate mb-1.5">{k.label}</div>
                <div className={`stat-value text-xl whitespace-nowrap ${k.key === 'utilidad' ? (k.current >= 0 ? 'text-emerald-700' : 'text-rose-700') : ''}`}>
                  <CountUp value={k.current} format={formatDop} />
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
          {/* Business-overview widgets — row 1: flujo · gastos · P&L. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 min-w-0">
            {/* Flujo de caja */}
            <div className="card p-4 flex flex-col">
              <CardHead title="Flujo de caja" to="/accounting/ledger" action="Ver mayor →" />
              <div className="font-display text-2xl font-semibold tabular-nums text-ink-900"><CountUp value={d.cash} format={formatDop} /></div>
              <div className="text-xs text-ink-400 mb-3">Saldo en caja y bancos</div>
              <div className="mt-auto">
                <BarPairs
                  data={d.monthsSeries.map((m) => ({ label: m.label, a: m.cashIn, b: m.cashOut }))}
                  colors={[C.in, C.out]} format={formatDop}
                />
                <div className="flex items-center justify-between gap-2">
                  <Legend items={[{ label: 'Entradas', color: C.in }, { label: 'Salidas', color: C.out }]} />
                  <span className="mt-3 text-xs whitespace-nowrap shrink-0">
                    <span className="text-ink-400">Neto 6m </span>
                    <span className={`tabular-nums font-medium ${cashNet >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{cashNet >= 0 ? '+' : ''}{formatDop(cashNet)}</span>
                  </span>
                </div>
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
                <CountUp value={d.utilidadMonth} format={formatDop} />
              </div>
              <div className="text-xs text-ink-400 mb-3">Utilidad neta de {monthLabel}</div>
              <div className="mt-auto">
                {d.pnl.income === 0 && d.pnl.net === 0 && d.egresosMonth === 0 ? (
                  <div className="flex items-center justify-center h-[132px] text-sm text-ink-400">Sin actividad este mes.</div>
                ) : (
                  <Waterfall
                    steps={[
                      { label: 'Ingresos', value: d.pnl.income, total: true },
                      { label: 'Costo', value: -d.pnl.costs },
                      { label: 'Gastos', value: -d.pnl.expenses },
                      { label: 'Utilidad', value: d.pnl.net, total: true },
                    ]}
                    colors={{ increase: C.income, decrease: C.expense, total: 'rgb(var(--ink-400))' }}
                    format={formatDop}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Row 2: cobros · ventas · bancos. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 min-w-0">
            {/* Cuentas por cobrar */}
            <div className="card p-4 flex flex-col">
              <CardHead title="Cuentas por cobrar" to="/accounting/cuentas" action="Ver cuentas →" />
              <div className="font-display text-2xl font-semibold tabular-nums text-ink-900"><CountUp value={d.ar.unpaid} format={formatDop} /></div>
              <div className="text-xs text-ink-400 mb-3">Sin cobrar{d.ar.dso != null ? ` · ${d.ar.dso} días de cobro (DSO)` : ''}</div>
              <div className="mt-auto">
                <AgingBars buckets={AGING.map((a) => ({ label: a.label, value: d.ar.buckets[a.key], tone: a.tone }))} format={formatDop} />
                <div className="flex justify-between items-center text-sm mt-3 pt-3 border-t border-ink-100">
                  <span className="text-ink-500">Cobrado (30 días)</span>
                  <span className="tabular-nums font-medium text-emerald-700"><CountUp value={d.collected30} format={formatDop} /></span>
                </div>
              </div>
            </div>

            {/* Ventas */}
            <div className="card p-4 flex flex-col">
              <CardHead title="Ventas" note="6 meses" />
              <div className="font-display text-2xl font-semibold tabular-nums text-ink-900"><CountUp value={ventasKpi?.current || 0} format={formatDop} /></div>
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
                <span className="tabular-nums font-semibold text-ink-900"><CountUp value={d.cash} format={formatDop} /></span>
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
                <Link to="/accounting/compras-gastos" className="text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors">Ver gastos →</Link>
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
              <div className="hidden md:block">
                <div className="flex justify-end mb-2">
                  <ColumnsMenu columns={segCols.columns} visible={segCols.visible} onChange={segCols.setVisible} onReset={() => { segCols.reset(); segW.reset(); }} />
                </div>
                <div className="overflow-x-auto">
                <table ref={segW.tableRef} style={segW.tableStyle} className="table">
                  <thead>
                    <tr>
                      {segCols.cols.map((col) => (
                        <th key={col.key} className={col.thClass || ''} {...segW.thProps(col.key)}>{col.key === 'segment' ? segLabel : col.label}{segW.ResizeHandle(col.key)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {segmented.rows.slice(0, 10).map((s) => {
                      const ctx = { s };
                      return (
                        <tr key={s.key} className="hover:bg-ink-50 transition-colors">
                          {segCols.cols.map((col) => (
                            <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ink-200 font-semibold">
                      {segCols.cols.map((col) => {
                        if (col.key === 'segment') return <td key={col.key}>{segmented.rows.length} segmentos</td>;
                        if (col.key === 'share') return <td key={col.key} />;
                        const total = col.key === 'count' ? segmented.totals.count : formatDop(segmented.totals[col.key]);
                        return <td key={col.key} className="text-right tabular-nums whitespace-nowrap">{total}</td>;
                      })}
                    </tr>
                  </tfoot>
                </table>
                </div>
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
              <div className="hidden md:block">
                <div className="flex justify-end mb-2">
                  <ColumnsMenu columns={compCols.columns} visible={compCols.visible} onChange={compCols.setVisible} onReset={() => { compCols.reset(); compW.reset(); }} />
                </div>
                <div className="overflow-x-auto">
                <table ref={compW.tableRef} style={compW.tableStyle} className="table">
                  <thead>
                    <tr>
                      {compCols.cols.map((col) => (
                        <th key={col.key} className={col.thClass || ''} {...compW.thProps(col.key)}>{col.label}{compW.ResizeHandle(col.key)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthly.map((m) => {
                      const ctx = { m };
                      return (
                        <tr key={m.key} className="hover:bg-ink-50 transition-colors">
                          {compCols.cols.map((col) => (
                            <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
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
              <>
              <div className="hidden md:flex justify-end px-4 pb-2">
                <ColumnsMenu columns={recentCols.columns} visible={recentCols.visible} onChange={recentCols.setVisible} onReset={() => { recentCols.reset(); recentW.reset(); }} />
              </div>
              <div className="overflow-x-auto">
                <table ref={recentW.tableRef} style={recentW.tableStyle} className="table">
                  <thead>
                    <tr>
                      {recentCols.cols.map((col) => (
                        <th key={col.key} className={col.thClass || ''} {...recentW.thProps(col.key)}>{col.label}{recentW.ResizeHandle(col.key)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.recent.map(({ entry, debit }) => {
                      const ctx = { entry, debit };
                      return (
                        <tr key={entry.id} onClick={() => navigate('/accounting/ledger?tab=diario')}
                          className="hover:bg-ink-50 transition-colors cursor-pointer" title="Ver en el diario">
                          {recentCols.cols.map((col) => (
                            <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>
        </div>
      )}
    </AccountingGate>
  );
}
