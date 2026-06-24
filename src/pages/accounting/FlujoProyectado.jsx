import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveReceivables, resolvePayables, resolveCashFlow, resolveCashForecast } from '../../core/accounting/index.js';

/**
 * Flujo proyectado — a 13-week cash-flow forecast: today's cash rolled forward
 * through the open cobros (inflows), open pagos + recurring bills (outflows),
 * with the runway low point flagged. Self-gates on accounting/admin.
 */
export default function FlujoProyectado() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const entriesQ = useLiveQueryStatus(() => db.journalEntries.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.journalLines.where('profileId').equals(scope).toArray(), [scope], []);
  const salesQ = useLiveQueryStatus(() => db.salesPostings.where('profileId').equals(scope).toArray(), [scope], []);
  const paymentsQ = useLiveQueryStatus(() => db.payments.where('profileId').equals(scope).toArray(), [scope], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const recurringQ = useLiveQueryStatus(() => db.recurringTemplates.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded && salesQ.loaded && paymentsQ.loaded
    && customersQ.loaded && purchasesQ.loaded && expensesQ.loaded && suppliersQ.loaded && recurringQ.loaded;

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);

  const receivables = useMemo(() => resolveReceivables({ salesPostings: salesQ.data, payments: paymentsQ.data, customersById }), [salesQ.data, paymentsQ.data, customersById]);
  const payables = useMemo(() => resolvePayables({ purchases: purchasesQ.data, expenses: expensesQ.data, payments: paymentsQ.data, suppliersById }), [purchasesQ.data, expensesQ.data, paymentsQ.data, suppliersById]);
  const openingCash = useMemo(() => resolveCashFlow({ accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data, end: Date.now() }).closing, [accountsQ.data, entriesQ.data, linesQ.data]);
  const forecast = useMemo(
    () => resolveCashForecast({ receivables, payables, recurring: recurringQ.data, openingCash, now: Date.now(), weeks: 13 }),
    [receivables, payables, recurringQ.data, openingCash],
  );

  return (
    <AccountingGate title="Flujo proyectado">
      <PageHeader title="Flujo de caja proyectado" subtitle="Proyección a 13 semanas — efectivo hoy, cobros y pagos esperados" />

      {!loaded ? <ListLoading /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">Efectivo hoy</div><div className="font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(forecast.openingCash)}</div></div>
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">Cobros 13s</div><div className="font-display text-lg font-semibold tabular-nums text-emerald-700 whitespace-nowrap overflow-x-auto">{formatDop(forecast.totalIn)}</div></div>
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">Pagos 13s</div><div className="font-display text-lg font-semibold tabular-nums text-rose-700 whitespace-nowrap overflow-x-auto">{formatDop(forecast.totalOut)}</div></div>
            <div className={`card p-3 min-w-0 ${forecast.negativeWeek ? 'border-rose-300' : ''}`}>
              <div className="eyebrow-xs text-ink-500 mb-1">Punto más bajo</div>
              <div className={`font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto ${forecast.lowPoint.balance < 0 ? 'text-rose-700' : 'text-ink-800'}`}>{formatDop(forecast.lowPoint.balance)}</div>
            </div>
          </div>

          {forecast.negativeWeek && (
            <div className="card p-3 mb-4 border-rose-300 bg-rose-50/40 flex items-center gap-2 text-sm text-rose-700">
              <AlertTriangle size={16} className="shrink-0" />
              El efectivo proyectado se vuelve negativo la semana del {formatDate(forecast.negativeWeek.weekStart)} ({formatDop(forecast.negativeWeek.balance)}).
            </div>
          )}

          <div className="card p-4 overflow-x-auto min-w-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-ink-200">
                  <th className="py-2 pr-3 text-left eyebrow-xs font-semibold text-ink-500">Semana</th>
                  <th className="py-2 px-3 text-right eyebrow-xs font-semibold text-ink-500">Cobros</th>
                  <th className="py-2 px-3 text-right eyebrow-xs font-semibold text-ink-500">Pagos</th>
                  <th className="py-2 px-3 text-right eyebrow-xs font-semibold text-ink-500">Neto</th>
                  <th className="py-2 pl-3 text-right eyebrow-xs font-semibold text-ink-500">Balance</th>
                </tr>
              </thead>
              <tbody>
                {forecast.rows.map((r) => (
                  <tr key={r.week} className="border-b border-ink-50 last:border-0">
                    <td className="py-1.5 pr-3 text-sm text-ink-600 whitespace-nowrap">{formatDate(r.weekStart)}</td>
                    <td className="py-1.5 px-3 text-right text-sm tabular-nums text-emerald-700 whitespace-nowrap">{r.inflow ? formatDop(r.inflow) : '—'}</td>
                    <td className="py-1.5 px-3 text-right text-sm tabular-nums text-rose-700 whitespace-nowrap">{r.outflow ? formatDop(r.outflow) : '—'}</td>
                    <td className={`py-1.5 px-3 text-right text-sm tabular-nums whitespace-nowrap ${r.net < 0 ? 'text-rose-600' : 'text-ink-600'}`}>{formatDop(r.net)}</td>
                    <td className={`py-1.5 pl-3 text-right text-sm tabular-nums font-semibold whitespace-nowrap ${r.balance < 0 ? 'text-rose-700' : 'text-ink-900'}`}>{formatDop(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-400 mt-2">Cobros = facturas con saldo, en su fecha. Pagos = compras/gastos a crédito con saldo + recurrentes activas. No incluye nómina futura ni planes de pago (próximamente).</p>
        </>
      )}
    </AccountingGate>
  );
}
