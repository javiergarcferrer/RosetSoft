import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Shield, Wallet, ArrowDownCircle, ArrowUpCircle, TrendingUp, TrendingDown,
  Receipt, FileWarning, AlertTriangle, BookOpen,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveAccountingDashboard } from '../../core/accounting/index.js';

function Kpi({ icon: Icon, label, value, tone, sub, to }) {
  const body = (
    <div className="card p-4 h-full">
      <div className="flex items-center gap-1.5 text-ink-500 text-[11px] uppercase tracking-wide mb-1.5">
        {Icon && <Icon size={14} />}{label}
      </div>
      <div className={`text-[22px] leading-none font-semibold tabular-nums ${tone || ''}`}>{value}</div>
      {sub && <div className="text-xs text-ink-400 mt-1.5">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} className="block transition hover:shadow-pop">{body}</Link> : body;
}

/**
 * Resumen contable — the accounting home. KPI cards (cash, CxC, CxP, month
 * result, ITBIS), alerts, top debtors/creditors and recent asientos, each
 * linking into its detail surface. Self-gates on accounting/admin.
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
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded && salesQ.loaded;

  const today = useMemo(() => new Date(), []);
  const monthStart = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1).getTime(), [today]);

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);

  const d = useMemo(() => resolveAccountingDashboard({
    accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data,
    salesPostings: salesQ.data, purchases: purchasesQ.data, expenses: expensesQ.data,
    payments: paymentsQ.data, imports: importsQ.data, customersById, suppliersById,
    monthStart, monthEnd: today.getTime(),
  }), [accountsQ.data, entriesQ.data, linesQ.data, salesQ.data, purchasesQ.data, expensesQ.data, paymentsQ.data, importsQ.data, customersById, suppliersById, monthStart, today]);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Resumen contable" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const monthLabel = today.toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
  const SOURCE = { manual: 'Manual', sale: 'Venta', expense: 'Gasto', purchase: 'Compra', payment: 'Pago', import: 'Importación', opening: 'Apertura', adjustment: 'Ajuste' };

  return (
    <>
      <PageHeader title="Resumen contable" subtitle={`Posición al ${formatDate(today.getTime())} · resultados de ${monthLabel}`} />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi icon={Wallet} label="Efectivo y bancos" value={formatDop(d.cash)} to="/accounting/ledger" />
            <Kpi icon={ArrowDownCircle} label="Por cobrar" value={formatDop(d.cxcBalance)} to="/accounting/cuentas"
              sub={d.overdue > 0 ? `${formatDop(d.overdue)} vencido +90` : 'al día'} tone={d.overdue > 0 ? 'text-rose-700' : ''} />
            <Kpi icon={ArrowUpCircle} label="Por pagar" value={formatDop(d.cxpBalance)} to="/accounting/cuentas" />
            <Kpi icon={d.utilidadMonth >= 0 ? TrendingUp : TrendingDown} label={`Utilidad ${monthLabel}`}
              value={formatDop(d.utilidadMonth)} tone={d.utilidadMonth >= 0 ? 'text-emerald-700' : 'text-rose-700'} to="/accounting/statements" />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="Ingresos del mes" value={formatDop(d.ingresosMonth)} to="/accounting/statements" />
            <Kpi label="Egresos del mes" value={formatDop(d.egresosMonth)} to="/accounting/statements" />
            <Kpi icon={Receipt} label="ITBIS del mes"
              value={formatDop(d.itbis.aPagar > 0 ? d.itbis.aPagar : d.itbis.aFavor)}
              sub={d.itbis.aPagar > 0 ? 'a pagar' : 'a favor'} to="/accounting/facturacion" />
            <Kpi icon={FileWarning} label="e-CF por transmitir" value={d.ecfPending}
              tone={d.ecfPending > 0 ? 'text-amber-700' : ''} to="/accounting/facturacion" />
          </div>

          {(d.ecfPending > 0 || d.overdue > 0) && (
            <div className="flex flex-wrap gap-2">
              {d.ecfPending > 0 && (
                <Link to="/accounting/facturacion" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-amber-50 text-amber-800 border border-amber-200">
                  <FileWarning size={14} /> {d.ecfPending} e-CF pendientes de transmitir a la DGII
                </Link>
              )}
              {d.overdue > 0 && (
                <Link to="/accounting/cuentas" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-rose-50 text-rose-800 border border-rose-200">
                  <AlertTriangle size={14} /> {formatDop(d.overdue)} en cuentas vencidas (+90 días)
                </Link>
              )}
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="eyebrow font-semibold text-ink-600">Mayores deudores</h2>
                <Link to="/accounting/cuentas" className="text-xs text-ink-500 hover:text-ink-800">Ver todo →</Link>
              </div>
              {d.cxcTop.length === 0 ? <p className="text-sm text-ink-400 py-3">Nada por cobrar.</p> : d.cxcTop.map((r) => (
                <div key={r.partyId} className="flex items-center justify-between py-1.5 border-b border-ink-50 text-sm">
                  <span className="truncate">{r.party?.name || '—'}</span>
                  <span className="tabular-nums font-medium">{formatDop(r.balance)}</span>
                </div>
              ))}
            </div>
            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="eyebrow font-semibold text-ink-600">Mayores acreedores</h2>
                <Link to="/accounting/cuentas" className="text-xs text-ink-500 hover:text-ink-800">Ver todo →</Link>
              </div>
              {d.cxpTop.length === 0 ? <p className="text-sm text-ink-400 py-3">Nada por pagar.</p> : d.cxpTop.map((r) => (
                <div key={r.partyId} className="flex items-center justify-between py-1.5 border-b border-ink-50 text-sm">
                  <span className="truncate">{r.party?.name || '—'}</span>
                  <span className="tabular-nums font-medium">{formatDop(r.balance)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="eyebrow font-semibold text-ink-600 inline-flex items-center gap-1.5"><BookOpen size={14} /> Asientos recientes</h2>
              <Link to="/accounting/ledger" className="text-xs text-ink-500 hover:text-ink-800">Ir al diario →</Link>
            </div>
            {d.recent.length === 0 ? <p className="text-sm text-ink-400 py-3">Aún no hay asientos.</p> : (
              <table className="w-full text-sm">
                <tbody>
                  {d.recent.map(({ entry, debit }) => (
                    <tr key={entry.id} className="border-b border-ink-50">
                      <td className="py-1.5 text-ink-500 w-24">{formatDate(entry.postedAt)}</td>
                      <td className="py-1.5"><span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-ink-100 text-ink-600 mr-2">{SOURCE[entry.source] || entry.source}</span>{entry.memo || '—'}</td>
                      <td className="py-1.5 text-right tabular-nums font-medium">{formatDop(debit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}
