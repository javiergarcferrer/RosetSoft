import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Percent, ChevronRight } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop } from '../../lib/format.js';
import { resolveItbisLiquidation } from '../../core/accounting/index.js';

/**
 * DGII — the single Dominican-fiscal pane. ALL DR tax logic routes from here:
 * the current-month ITBIS position plus the 606 (compras), 607 (ventas), IT-1
 * (liquidación) and the e-CF / comprobantes. Kept deliberately apart from the
 * core books so the jurisdiction-specific surface is swappable (DR→PR). Reads
 * from core data (sales postings, gastos, compras, importaciones); never enters
 * it. Self-gates on accounting/admin.
 */
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export default function Impuestos() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const salesQ = useLiveQueryStatus(() => db.salesPostings.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = salesQ.loaded && expensesQ.loaded && purchasesQ.loaded && importsQ.loaded && expedientesQ.loaded;

  const today = useMemo(() => new Date(), []);
  const win = useMemo(() => ({
    start: new Date(today.getFullYear(), today.getMonth(), 1).getTime(),
    end: today.getTime(),
  }), [today]);
  const itbis = useMemo(() => resolveItbisLiquidation({
    salesPostings: salesQ.data, expenses: expensesQ.data, purchases: purchasesQ.data,
    imports: importsQ.data, expedientes: expedientesQ.data, ...win,
  }), [salesQ.data, expensesQ.data, purchasesQ.data, importsQ.data, expedientesQ.data, win]);

  const monthLabel = `${MONTHS[today.getMonth()]} ${today.getFullYear()}`;
  const forms = [
    { code: '606', label: 'Compras y gastos (606)', desc: 'Comprobantes de proveedores del mes', to: '/accounting/expenses?tab=606' },
    { code: '607', label: 'Ventas (607)', desc: 'Comprobantes de ventas del mes', to: '/accounting/facturacion?tab=607' },
    { code: 'IT-1', label: 'Liquidación de ITBIS (IT-1)', desc: 'Débito fiscal − crédito fiscal', to: '/accounting/facturacion?tab=it1' },
    { code: 'e-CF', label: 'Comprobantes e-CF', desc: 'Emisión / transmisión y secuencias e-NCF', to: '/accounting/facturacion?tab=607' },
  ];

  return (
    <AccountingGate title="DGII">
      <PageHeader title="DGII" subtitle={`Operaciones fiscales · ITBIS de ${monthLabel}`} />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4">
          <div className="card p-5 max-w-2xl">
            <h2 className="eyebrow font-semibold text-ink-600 mb-3 inline-flex items-center gap-1.5"><Percent size={14} /> ITBIS del mes</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="min-w-0">
                <div className="eyebrow mb-1">Débito fiscal (ventas)</div>
                <div className="font-display text-xl font-semibold tabular-nums whitespace-nowrap">{formatDop(itbis.debitoFiscal)}</div>
              </div>
              <div className="min-w-0">
                <div className="eyebrow mb-1">Crédito fiscal (compras)</div>
                <div className="font-display text-xl font-semibold tabular-nums whitespace-nowrap">{formatDop(itbis.creditoFiscal)}</div>
                <div className="text-xs text-ink-400 tabular-nums mt-0.5">
                  Local {formatDop(itbis.creditoLocal)} · Importación {formatDop(itbis.creditoImportacion)}
                </div>
              </div>
              <div className="min-w-0">
                <div className="eyebrow mb-1">{itbis.aPagar > 0 ? 'A pagar' : 'Saldo a favor'}</div>
                <div className={`font-display text-xl font-bold tabular-nums whitespace-nowrap ${itbis.aPagar > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {formatDop(itbis.aPagar > 0 ? itbis.aPagar : itbis.aFavor)}
                </div>
              </div>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {forms.map((f) => (
              <Link key={f.code} to={f.to} className="card-interactive p-4 group hover:-translate-y-0.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="badge font-semibold">{f.code}</span>
                  <ChevronRight size={16} className="text-ink-300 group-hover:text-ink-600 transition-colors" />
                </div>
                <div className="text-sm font-medium text-ink-900 mt-1">{f.label}</div>
                <div className="text-xs text-ink-500 mt-0.5">{f.desc}</div>
              </Link>
            ))}
          </div>

          <p className="text-xs text-ink-400 max-w-2xl">
            Los formatos 606/607 se exportan en CSV (y TXT para la Oficina Virtual) desde cada
            reporte. La emisión y transmisión de e-CF, junto con las secuencias e-NCF, viven en
            esta misma sección DGII.
          </p>
        </div>
      )}
    </AccountingGate>
  );
}
