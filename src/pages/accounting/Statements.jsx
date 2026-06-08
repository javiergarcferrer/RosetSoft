import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Shield, Scale, TrendingUp, Download } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import { downloadCsv } from '../../lib/csv.js';
import { resolveBalanceSheet, resolveIncomeStatement } from '../../core/accounting/index.js';

/** Flatten a statement tree into CSV rows [code, name, amount]. */
function flattenTree(node, rows = [], depth = 0) {
  if (!node) return rows;
  rows.push([node.code, `${'  '.repeat(depth)}${node.name}`, node.amount]);
  for (const c of node.children || []) flattenTree(c, rows, depth + 1);
  return rows;
}

/**
 * Estados financieros — Balance General (Estado de Situación) + Estado de
 * Resultados, both pure projections of the general ledger (core/accounting).
 * The Balance folds the period result into equity so it balances before the
 * closing entry. Self-gates on the accounting/admin role.
 */
function TreeRows({ node, depth = 0 }) {
  if (!node) return null;
  return (
    <>
      <div className="flex items-center justify-between py-1 gap-2 min-w-0" style={{ paddingLeft: `${Math.min(depth * 16, 48)}px` }}>
        {node.isPostable ? (
          <Link to={`/accounting/ledger?cuenta=${node.code}`} className="text-sm text-ink-700 min-w-0 truncate hover:text-ink-900 hover:underline flex-1">
            <code className="text-[11px] text-ink-400 mr-1 tabular-nums">{node.code}</code>{node.name}
          </Link>
        ) : (
          <span className="text-sm font-semibold text-ink-900 min-w-0 truncate flex-1">
            <code className="text-[11px] text-ink-400 mr-1 tabular-nums">{node.code}</code>{node.name}
          </span>
        )}
        <span className={`text-sm tabular-nums whitespace-nowrap shrink-0 ${node.isPostable ? 'text-ink-600' : 'font-semibold'}`}>
          {formatDop(node.amount)}
        </span>
      </div>
      {node.children.map((c) => <TreeRows key={c.code} node={c} depth={depth + 1} />)}
    </>
  );
}

function SectionTotal({ label, value, strong }) {
  return (
    <div className={`flex items-center justify-between gap-3 py-2 mt-1 border-t min-w-0 ${strong ? 'border-ink-300' : 'border-ink-100'}`}>
      <span className={`min-w-0 ${strong ? 'text-sm font-bold' : 'text-sm font-semibold text-ink-700'}`}>{label}</span>
      <span className={`tabular-nums whitespace-nowrap shrink-0 ${strong ? 'text-base font-bold' : 'text-sm font-semibold'}`}>
        {formatDop(value)}
      </span>
    </div>
  );
}

export default function Statements() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';

  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') === 'income' ? 'income' : 'balance'); // 'balance' | 'income'
  const today = useMemo(() => new Date(), []);
  const [asOf, setAsOf] = useState(() => isoDate(today.getTime()));
  const [start, setStart] = useState(() => isoDate(new Date(today.getFullYear(), 0, 1).getTime()));
  const [end, setEnd] = useState(() => isoDate(today.getTime()));

  const accountsQ = useLiveQueryStatus(
    () => db.accounts.where('profileId').equals(profileId || 'team').toArray(), [profileId], [],
  );
  const entriesQ = useLiveQueryStatus(
    () => db.journalEntries.where('profileId').equals(profileId || 'team').toArray(), [profileId], [],
  );
  const linesQ = useLiveQueryStatus(
    () => db.journalLines.where('profileId').equals(profileId || 'team').toArray(), [profileId], [],
  );
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded;

  const balance = useMemo(() => resolveBalanceSheet({
    accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data,
    asOf: parseISODate(asOf, true),
  }), [accountsQ.data, entriesQ.data, linesQ.data, asOf]);

  const income = useMemo(() => resolveIncomeStatement({
    accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data,
    start: parseISODate(start), end: parseISODate(end, true),
  }), [accountsQ.data, entriesQ.data, linesQ.data, start, end]);

  function exportActive() {
    if (tab === 'balance') {
      downloadCsv(`balance_${asOf}.csv`, [
        ['Cuenta', 'Nombre', 'Monto'],
        ...flattenTree(balance.assets), ['', 'TOTAL ACTIVOS', balance.totalAssets],
        ...flattenTree(balance.liabilities), ['', 'TOTAL PASIVOS', balance.totalLiabilities],
        ...flattenTree(balance.equity), ['', 'Resultado del ejercicio', balance.netIncome],
        ['', 'TOTAL PATRIMONIO', balance.totalEquity], ['', 'TOTAL PASIVOS + PATRIMONIO', balance.totalLiabEquity],
      ]);
    } else {
      downloadCsv(`resultados_${start}_${end}.csv`, [
        ['Cuenta', 'Nombre', 'Monto'],
        ...flattenTree(income.income), ['', 'TOTAL INGRESOS', income.totalIncome],
        ...flattenTree(income.costs), ['', 'UTILIDAD BRUTA', income.grossProfit],
        ...flattenTree(income.expenses), ['', 'TOTAL GASTOS', income.totalExpenses],
        ['', 'UTILIDAD NETA DEL PERIODO', income.netIncome],
      ]);
    }
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Estados financieros" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const dateInput = 'rounded-lg border border-ink-200 px-3 py-2 text-sm min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ink-300';

  return (
    <>
      <PageHeader title="Estados financieros" subtitle="Proyecciones del libro mayor — valores en RD$" />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button type="button" onClick={() => setTab('balance')}
          className={`text-sm px-3 py-2 rounded-lg inline-flex items-center gap-1.5 min-h-[44px] ${tab === 'balance' ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>
          <Scale size={15} /> Balance General
        </button>
        <button type="button" onClick={() => setTab('income')}
          className={`text-sm px-3 py-2 rounded-lg inline-flex items-center gap-1.5 min-h-[44px] ${tab === 'income' ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>
          <TrendingUp size={15} /> Estado de Resultados
        </button>
        <button type="button" onClick={exportActive}
          className="sm:ml-auto btn-ghost text-sm inline-flex items-center gap-1.5 min-h-[44px]"><Download size={14} /> Exportar</button>
      </div>

      {!loaded ? <ListLoading /> : tab === 'balance' ? (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
            <label className="text-ink-500">Al</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={dateInput} />
            <span className={`sm:ml-auto text-xs px-2 py-1 rounded whitespace-nowrap ${balance.balanced ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
              {balance.balanced ? 'Cuadrado' : `Descuadre: ${formatDop(balance.difference)}`}
            </span>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="card p-4 min-w-0">
              <h2 className="eyebrow font-semibold text-ink-600 mb-2">Activos</h2>
              <TreeRows node={balance.assets} />
              <SectionTotal label="Total activos" value={balance.totalAssets} strong />
            </div>
            <div className="card p-4 min-w-0">
              <h2 className="eyebrow font-semibold text-ink-600 mb-2">Pasivos y patrimonio</h2>
              <TreeRows node={balance.liabilities} />
              <SectionTotal label="Total pasivos" value={balance.totalLiabilities} />
              <div className="mt-3">
                <TreeRows node={balance.equity} />
                <div className="flex items-center justify-between py-1 gap-2 min-w-0">
                  <span className="text-sm text-ink-700 min-w-0">Resultado del ejercicio</span>
                  <span className="text-sm tabular-nums text-ink-600 whitespace-nowrap shrink-0">{formatDop(balance.netIncome)}</span>
                </div>
                <SectionTotal label="Total patrimonio" value={balance.totalEquity} />
              </div>
              <SectionTotal label="Total pasivos + patrimonio" value={balance.totalLiabEquity} strong />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
            <label className="text-ink-500">Desde</label>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={dateInput} />
            <label className="text-ink-500">Hasta</label>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={dateInput} />
          </div>
          <div className="card p-4 max-w-2xl min-w-0">
            <h2 className="eyebrow font-semibold text-ink-600 mb-2">Ingresos</h2>
            <TreeRows node={income.income} />
            <SectionTotal label="Total ingresos" value={income.totalIncome} />

            <h2 className="eyebrow font-semibold text-ink-600 mb-2 mt-4">Costos</h2>
            <TreeRows node={income.costs} />
            <SectionTotal label="Utilidad bruta" value={income.grossProfit} />

            <h2 className="eyebrow font-semibold text-ink-600 mb-2 mt-4">Gastos</h2>
            <TreeRows node={income.expenses} />
            <SectionTotal label="Total gastos" value={income.totalExpenses} />

            <SectionTotal label="Utilidad neta del período" value={income.netIncome} strong />
          </div>
        </>
      )}
    </>
  );
}
