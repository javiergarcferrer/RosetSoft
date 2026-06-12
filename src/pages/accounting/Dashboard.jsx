import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Shield, Wallet, ArrowDownCircle, ArrowUpCircle,
  Receipt, FileWarning, AlertTriangle, BookOpen, Landmark,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { Donut, BarPairs, AreaChart, Legend } from '../../components/charts/MiniCharts.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveAccountingDashboard } from '../../core/accounting/index.js';

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
  current: '#aba79a',  // ink-300
};
// Donut slice ramp (gastos por categoría).
const DONUT = ['#c96a2a', '#e8a76d', '#059669', '#878374', '#f59e0b', '#cfccc4'];

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
    <div className="card card-pad h-full flex flex-col gap-2 transition-shadow min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {Icon && (
          <span className="w-7 h-7 rounded-lg bg-ink-100 ring-1 ring-inset ring-black/5 flex items-center justify-center text-ink-500 shrink-0">
            <Icon size={14} />
          </span>
        )}
        <span className="eyebrow-xs tracking-wide text-ink-500 min-w-0 truncate">{label}</span>
      </div>
      <div className={`text-xl leading-none font-semibold tabular-nums break-all ${tone || 'text-ink-900'}`}>{value}</div>
      {sub && <div className="text-xs text-ink-400 break-words">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} className="block hover:shadow-soft active:scale-[0.99] transition-all min-w-0">{body}</Link> : body;
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
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
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
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded && salesQ.loaded;

  const today = useMemo(() => new Date(), []);
  const monthStart = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1).getTime(), [today]);

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);

  const d = useMemo(() => resolveAccountingDashboard({
    accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data,
    salesPostings: salesQ.data, purchases: purchasesQ.data, expenses: expensesQ.data,
    payments: paymentsQ.data, imports: importsQ.data, expedientes: expedientesQ.data,
    customersById, suppliersById,
    monthStart, monthEnd: today.getTime(),
  }), [accountsQ.data, entriesQ.data, linesQ.data, salesQ.data, purchasesQ.data, expensesQ.data, paymentsQ.data, importsQ.data, expedientesQ.data, customersById, suppliersById, monthStart, today]);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Resumen del negocio" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const monthLabel = today.toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
  const monthSales = d.monthsSeries.length ? d.monthsSeries[d.monthsSeries.length - 1].sales : 0;
  const pnlMax = Math.max(d.ingresosMonth, d.egresosMonth, 1);
  const arTotal = Math.max(d.ar.unpaid, 1);

  return (
    <>
      <PageHeader title="Resumen del negocio" subtitle={`Posición al ${formatDate(today.getTime())} · ${monthLabel}`} />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4 min-w-0">
          {/* Urgent flags float to the top. */}
          {(d.ecfPending > 0 || d.overdue > 0) && (
            <div className="flex flex-wrap gap-2">
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
              <div className="text-2xl font-semibold tabular-nums text-ink-900">{formatDop(d.cash)}</div>
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
              <div className={`text-2xl font-semibold tabular-nums ${d.utilidadMonth >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
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
              <div className="text-2xl font-semibold tabular-nums text-ink-900">{formatDop(d.ar.unpaid)}</div>
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
              <div className="text-2xl font-semibold tabular-nums text-ink-900">{formatDop(monthSales)}</div>
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
            <Kpi icon={Receipt} label="ITBIS del mes"
              value={formatDop(d.itbis.aPagar > 0 ? d.itbis.aPagar : d.itbis.aFavor)}
              sub={d.itbis.aPagar > 0 ? 'a pagar' : 'a favor'} to="/accounting/facturacion" />
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
    </>
  );
}
