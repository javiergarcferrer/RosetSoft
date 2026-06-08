import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Percent, ChevronRight } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop } from '../../lib/format.js';
import { resolveItbisLiquidation } from '../../core/accounting/index.js';

/**
 * Centro de impuestos — the DGII tax hub (QuickBooks "Taxes" center). Shows the
 * current-month ITBIS position and links to the 606 / 607 / IT-1. Self-gates on
 * accounting/admin.
 */
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export default function Impuestos() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

  const salesQ = useLiveQueryStatus(() => db.salesPostings.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = salesQ.loaded && expensesQ.loaded && purchasesQ.loaded;

  const today = useMemo(() => new Date(), []);
  const win = useMemo(() => ({
    start: new Date(today.getFullYear(), today.getMonth(), 1).getTime(),
    end: today.getTime(),
  }), [today]);
  const itbis = useMemo(() => resolveItbisLiquidation({
    salesPostings: salesQ.data, expenses: expensesQ.data, purchases: purchasesQ.data, imports: importsQ.data, ...win,
  }), [salesQ.data, expensesQ.data, purchasesQ.data, importsQ.data, win]);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Centro de impuestos" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const monthLabel = `${MONTHS[today.getMonth()]} ${today.getFullYear()}`;
  const forms = [
    { code: '606', label: 'Compras y gastos (606)', desc: 'Comprobantes de proveedores del mes', to: '/accounting/expenses?tab=606' },
    { code: '607', label: 'Ventas (607)', desc: 'Comprobantes de ventas del mes', to: '/accounting/facturacion?tab=607' },
    { code: 'IT-1', label: 'Liquidación de ITBIS (IT-1)', desc: 'Débito fiscal − crédito fiscal', to: '/accounting/facturacion?tab=it1' },
  ];

  return (
    <>
      <PageHeader title="Centro de impuestos" subtitle={`Posición de ITBIS · ${monthLabel}`} />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4">
          <div className="card p-5 max-w-2xl">
            <h2 className="eyebrow font-semibold text-ink-600 mb-3 inline-flex items-center gap-1.5"><Percent size={14} /> ITBIS del mes</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Débito fiscal (ventas)</div>
                <div className="text-xl font-semibold tabular-nums">{formatDop(itbis.debitoFiscal)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Crédito fiscal (compras)</div>
                <div className="text-xl font-semibold tabular-nums">{formatDop(itbis.creditoFiscal)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">{itbis.aPagar > 0 ? 'A pagar' : 'Saldo a favor'}</div>
                <div className={`text-xl font-bold tabular-nums ${itbis.aPagar > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {formatDop(itbis.aPagar > 0 ? itbis.aPagar : itbis.aFavor)}
                </div>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {forms.map((f) => (
              <Link key={f.code} to={f.to} className="card p-4 group hover:shadow-pop transition">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-ink-100 text-ink-700">{f.code}</span>
                  <ChevronRight size={16} className="text-ink-300 group-hover:text-ink-600" />
                </div>
                <div className="text-sm font-medium text-ink-900 mt-1">{f.label}</div>
                <div className="text-xs text-ink-500 mt-0.5">{f.desc}</div>
              </Link>
            ))}
          </div>

          <p className="text-xs text-ink-400 max-w-2xl">
            Los formatos 606/607 se exportan en CSV desde cada reporte. La integración de envío
            directo y los e-CF se gestionan en Ventas → Facturación.
          </p>
        </div>
      )}
    </>
  );
}
