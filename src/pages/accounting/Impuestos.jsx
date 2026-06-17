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
import { resolveItbisLiquidation, activeFiscalPlugin, resolveFilingDeadline } from '../../core/accounting/index.js';

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
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  // Everything jurisdiction-specific on this pane — the authority name, the tax
  // label, the list of filings — comes from the active fiscal plugin (DGII).
  // Swap the plugin and this pane re-skins for the new country; nothing here
  // hardcodes "DGII" or "ITBIS".
  const fiscal = activeFiscalPlugin(settings);

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
  // The filings to file — straight from the plugin (DR: 606 · 607 · IT-1 · e-CF).
  const forms = fiscal.reports;
  // Live filing deadlines per report (the periodic ones carry a `dueDay`); the
  // View only formats — the math lives in the plugin's resolveFilingDeadline VM.
  const deadlines = useMemo(
    () => Object.fromEntries(forms.map((f) => [f.code, resolveFilingDeadline(f.dueDay, today.getTime())])),
    [forms, today],
  );

  return (
    <AccountingGate title={fiscal.authority}>
      <PageHeader title={fiscal.authority} subtitle={`Operaciones fiscales · ${fiscal.tax.name} de ${monthLabel}`} />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4">
          <div className="card p-5 max-w-2xl">
            <h2 className="eyebrow font-semibold text-ink-600 mb-3 inline-flex items-center gap-1.5"><Percent size={14} /> {fiscal.tax.name} del mes</h2>
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
                <div className="text-xs text-ink-500 mt-0.5">{f.description}</div>
                {deadlines[f.code] && (
                  <div className={`text-[11px] font-medium tabular-nums mt-1.5 ${deadlines[f.code].daysLeft <= 3 ? 'text-rose-600' : 'text-ink-400'}`}>
                    Vence {new Date(deadlines[f.code].dueAt).getDate()} {MONTHS[new Date(deadlines[f.code].dueAt).getMonth()].slice(0, 3).toLowerCase()}
                    {' · '}
                    {deadlines[f.code].daysLeft === 0 ? 'hoy' : `faltan ${deadlines[f.code].daysLeft} días`}
                  </div>
                )}
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
