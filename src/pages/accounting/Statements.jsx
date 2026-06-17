import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Scale, TrendingUp, Download, Table2, BarChart3 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import PeriodNav, { DeltaChip } from '../../components/accounting/PeriodNav.jsx';
import { YoYColumns, Waterfall, Donut, Legend, CountUp } from '../../components/charts/MiniCharts.jsx';
import { formatDop } from '../../lib/format.js';
import { downloadCsv } from '../../lib/csv.js';
import {
  resolveBalanceSheetComparison, resolveIncomeStatementComparison,
  resolvePeriod, deltaPct,
} from '../../core/accounting/index.js';

// Chart palette (shared with the dashboard tokens).
const C = { sales: '#c96a2a', income: '#059669', expense: '#fb7185' };

const COMPARE = [
  { key: 'none', label: 'Sin comparar' },
  { key: 'prev', label: 'Período anterior' },
  { key: 'yoy', label: 'Año anterior' },
];

/** Flatten a multi-period statement node into CSV rows [code, name, ...amounts]. */
function flattenMulti(node, rows = [], depth = 0) {
  if (!node) return rows;
  rows.push([node.code, `${'  '.repeat(depth)}${node.name}`, ...node.amounts]);
  for (const c of node.children || []) flattenMulti(c, rows, depth + 1);
  return rows;
}

const slug = (s) => String(s).trim().replace(/\s+/g, '-');

/* ----------------------------- table pieces ----------------------------- */

/** Column header: Cuenta + one labeled amount column per period (+ Δ). */
function StatementHead({ periods, showDelta }) {
  return (
    <thead>
      <tr className="border-b border-ink-200">
        <th className="py-2 pr-3 text-left eyebrow-xs font-semibold text-ink-500">Cuenta</th>
        {periods.map((p, i) => (
          <th key={i} className={`py-2 pl-3 text-right eyebrow-xs font-semibold capitalize whitespace-nowrap ${i > 0 ? 'text-ink-400' : 'text-ink-600'}`}>
            {p.label}
          </th>
        ))}
        {showDelta && <th className="py-2 pl-3 text-right eyebrow-xs font-semibold text-ink-500">Δ</th>}
      </tr>
    </thead>
  );
}

/** A full-width section title row inside the shared statement table. */
function SectionRow({ title, colCount, first }) {
  return (
    <tr>
      <td colSpan={colCount} className={`${first ? 'pt-1' : 'pt-4'} pb-1`}>
        <span className="eyebrow font-semibold text-ink-600">{title}</span>
      </td>
    </tr>
  );
}

/** Recursive account rows — one amount cell per period; comparison cols muted. */
function AmountRows({ node, depth = 0, showDelta }) {
  if (!node) return null;
  return (
    <>
      <tr className="border-b border-ink-50 last:border-0">
        <td className="py-1.5 pr-3 min-w-0" style={{ paddingLeft: `${Math.min(depth * 14, 42)}px` }}>
          {node.isPostable ? (
            <Link to={`/accounting/ledger?cuenta=${node.code}`} className="text-sm text-ink-700 hover:text-ink-900 hover:underline break-words">
              <code className="text-[11px] text-ink-400 mr-1 tabular-nums">{node.code}</code>{node.name}
            </Link>
          ) : (
            <span className="text-sm font-semibold text-ink-900 break-words">
              <code className="text-[11px] text-ink-400 mr-1 tabular-nums">{node.code}</code>{node.name}
            </span>
          )}
        </td>
        {node.amounts.map((a, i) => (
          <td key={i} className={`py-1.5 pl-3 text-right text-sm tabular-nums whitespace-nowrap ${i > 0 ? 'text-ink-400' : node.isPostable ? 'text-ink-600' : 'font-semibold text-ink-900'}`}>
            {formatDop(a)}
          </td>
        ))}
        {showDelta && (
          <td className="py-1.5 pl-3 text-right whitespace-nowrap">
            <DeltaChip delta={deltaPct(node.amounts[0], node.amounts[1])} />
          </td>
        )}
      </tr>
      {node.children.map((c) => <AmountRows key={c.code} node={c} depth={depth + 1} showDelta={showDelta} />)}
    </>
  );
}

/** A subtotal / total row spanning the same columns. */
function TotalRow({ label, amounts, strong, showDelta }) {
  return (
    <tr className={`border-t ${strong ? 'border-ink-300' : 'border-ink-100'}`}>
      <td className={`py-2 pr-3 ${strong ? 'text-sm font-bold' : 'text-sm font-semibold text-ink-700'}`}>{label}</td>
      {amounts.map((a, i) => (
        <td key={i} className={`py-2 pl-3 text-right tabular-nums whitespace-nowrap ${strong ? 'text-base font-bold' : 'text-sm font-semibold'} ${i > 0 ? 'opacity-60' : ''}`}>
          {formatDop(a)}
        </td>
      ))}
      {showDelta && (
        <td className="py-2 pl-3 text-right whitespace-nowrap"><DeltaChip delta={deltaPct(amounts[0], amounts[1])} /></td>
      )}
    </tr>
  );
}

/** KPI scorecard — hero value (period 0) + delta vs the comparison period. */
function StatKpi({ label, amounts, tone, showDelta, vs }) {
  return (
    <div className="stat-card p-3.5 min-w-0">
      <div className="eyebrow-xs text-ink-500 truncate mb-1.5">{label}</div>
      <div className={`stat-value text-xl whitespace-nowrap ${tone ? (amounts[0] >= 0 ? 'text-emerald-700' : 'text-rose-700') : ''}`}>
        <CountUp value={amounts[0]} format={formatDop} />
      </div>
      {showDelta && (
        <div className="flex items-center gap-1.5 mt-1">
          <DeltaChip delta={deltaPct(amounts[0], amounts[1])} vs={vs} />
          <span className="text-[10px] text-ink-300 uppercase tracking-wide truncate">vs {vs}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Estados financieros — Balance General (Estado de Situación) + Estado de
 * Resultados, both pure projections of the general ledger (core/accounting),
 * now period-driven: a quick Mes/Trimestre/Año navigator instead of hand-typed
 * dates, an optional comparison against the previous period or the same period
 * last year, and a Tabla / Gráfico switch so the periods read side by side or as
 * a chart. The Balance folds the period result into equity so each column
 * balances before the closing entry. Self-gates on accounting/admin.
 */
export default function Statements() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') === 'income' ? 'income' : 'balance'); // 'balance' | 'income'
  const [periodSel, setPeriodSel] = useState({ kind: 'month', ref: Date.now() });
  const [compare, setCompare] = useState('none'); // 'none' | 'prev' | 'yoy'
  const [view, setView] = useState('table'); // 'table' | 'chart'

  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const entriesQ = useLiveQueryStatus(() => db.journalEntries.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.journalLines.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded;

  const period = useMemo(() => resolvePeriod(periodSel), [periodSel]);
  const showDelta = compare !== 'none';
  const cmpRef = compare === 'yoy' ? period.yoy : period.prev;

  const income = useMemo(() => {
    const cur = { label: period.label, start: period.start, end: period.end };
    const periods = showDelta ? [cur, { label: cmpRef.label, start: cmpRef.start, end: cmpRef.end }] : [cur];
    return resolveIncomeStatementComparison({
      accounts: accountsQ.data, lines: linesQ.data, entries: entriesQ.data, periods,
    });
  }, [accountsQ.data, linesQ.data, entriesQ.data, period, cmpRef, showDelta]);

  const balance = useMemo(() => {
    const cur = { label: period.label, asOf: period.end };
    const periods = showDelta ? [cur, { label: cmpRef.label, asOf: cmpRef.end }] : [cur];
    return resolveBalanceSheetComparison({
      accounts: accountsQ.data, lines: linesQ.data, entries: entriesQ.data, periods,
    });
  }, [accountsQ.data, linesQ.data, entriesQ.data, period, cmpRef, showDelta]);

  const vsLabel = showDelta ? cmpRef.label : '';

  function exportActive() {
    if (tab === 'balance') {
      const head = ['Cuenta', 'Nombre', ...balance.periods.map((p) => p.label)];
      downloadCsv(`balance_${slug(period.label)}${showDelta ? `_vs_${slug(cmpRef.label)}` : ''}.csv`, [
        head,
        ...flattenMulti(balance.assets), ['', 'TOTAL ACTIVOS', ...balance.totalAssets],
        ...flattenMulti(balance.liabilities), ['', 'TOTAL PASIVOS', ...balance.totalLiabilities],
        ...flattenMulti(balance.equity), ['', 'Resultado del ejercicio', ...balance.netIncome],
        ['', 'TOTAL PATRIMONIO', ...balance.totalEquity],
        ['', 'TOTAL PASIVOS + PATRIMONIO', ...balance.totalLiabEquity],
      ]);
    } else {
      const head = ['Cuenta', 'Nombre', ...income.periods.map((p) => p.label)];
      downloadCsv(`resultados_${slug(period.label)}${showDelta ? `_vs_${slug(cmpRef.label)}` : ''}.csv`, [
        head,
        ...flattenMulti(income.income), ['', 'TOTAL INGRESOS', ...income.totalIncome],
        ...flattenMulti(income.costs), ['', 'UTILIDAD BRUTA', ...income.grossProfit],
        ...flattenMulti(income.expenses), ['', 'TOTAL GASTOS', ...income.totalExpenses],
        ['', 'UTILIDAD NETA DEL PERIODO', ...income.netIncome],
      ]);
    }
  }

  const colCount = 1 + (tab === 'balance' ? balance.periods.length : income.periods.length) + (showDelta ? 1 : 0);

  return (
    <AccountingGate title="Estados financieros">
      <PageHeader title="Estados financieros" subtitle="Proyecciones del libro mayor — valores en RD$"
        actions={<PeriodNav kind={periodSel.kind} refMs={periodSel.ref} onChange={setPeriodSel} />} />

      <div className="flex flex-wrap items-start gap-2">
        <TabPills
          tabs={[
            { key: 'balance', label: <><Scale size={15} /> Balance General</> },
            { key: 'income', label: <><TrendingUp size={15} /> Estado de Resultados</> },
          ]}
          active={tab} onChange={setTab} />
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <div className="flex gap-1">
            {COMPARE.map((c) => (
              <button key={c.key} type="button" onClick={() => setCompare(c.key)}
                className={`btn text-xs ${compare === c.key ? 'tab-pill-active' : 'tab-pill'}`}>{c.label}</button>
            ))}
          </div>
          <div className="flex gap-1">
            <button type="button" onClick={() => setView('table')}
              className={`btn text-xs ${view === 'table' ? 'tab-pill-active' : 'tab-pill'}`}><Table2 size={14} /> Tabla</button>
            <button type="button" onClick={() => setView('chart')}
              className={`btn text-xs ${view === 'chart' ? 'tab-pill-active' : 'tab-pill'}`}><BarChart3 size={14} /> Gráfico</button>
          </div>
          <button type="button" onClick={exportActive} className="btn-ghost"><Download size={14} /> Exportar</button>
        </div>
      </div>

      {!loaded ? <ListLoading /> : tab === 'balance' ? (
        <>
          {/* KPI band — totals at the cut-off, with delta vs the comparison. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 my-4 min-w-0">
            <StatKpi label="Activos" amounts={balance.totalAssets} showDelta={showDelta} vs={vsLabel} />
            <StatKpi label="Pasivos" amounts={balance.totalLiabilities} showDelta={showDelta} vs={vsLabel} />
            <StatKpi label="Patrimonio" amounts={balance.totalEquity} showDelta={showDelta} vs={vsLabel} />
            <div className="stat-card p-3.5 min-w-0 flex flex-col justify-center">
              <div className="eyebrow-xs text-ink-500 truncate mb-1.5">Cuadre</div>
              <span className={`status-pill whitespace-nowrap self-start ${balance.balanced[0] ? 'status-pill-accepted' : 'bg-rose-100 text-rose-700'}`}>
                {balance.balanced[0] ? 'Cuadrado' : `Descuadre: ${formatDop(balance.difference[0])}`}
              </span>
            </div>
          </div>

          {view === 'table' ? (
            <div className="card p-4 overflow-x-auto min-w-0">
              <table className="w-full">
                <StatementHead periods={balance.periods} showDelta={showDelta} />
                <tbody>
                  <SectionRow title="Activos" colCount={colCount} first />
                  <AmountRows node={balance.assets} showDelta={showDelta} />
                  <TotalRow label="Total activos" amounts={balance.totalAssets} strong showDelta={showDelta} />

                  <SectionRow title="Pasivos" colCount={colCount} />
                  <AmountRows node={balance.liabilities} showDelta={showDelta} />
                  <TotalRow label="Total pasivos" amounts={balance.totalLiabilities} showDelta={showDelta} />

                  <SectionRow title="Patrimonio" colCount={colCount} />
                  <AmountRows node={balance.equity} showDelta={showDelta} />
                  <TotalRow label="Resultado del ejercicio" amounts={balance.netIncome} showDelta={showDelta} />
                  <TotalRow label="Total patrimonio" amounts={balance.totalEquity} showDelta={showDelta} />

                  <TotalRow label="Total pasivos + patrimonio" amounts={balance.totalLiabEquity} strong showDelta={showDelta} />
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card p-4 min-w-0">
              {showDelta ? (
                <>
                  <YoYColumns
                    data={[
                      { label: 'Activos', value: balance.totalAssets[0], prev: balance.totalAssets[1] },
                      { label: 'Pasivos', value: balance.totalLiabilities[0], prev: balance.totalLiabilities[1] },
                      { label: 'Patrimonio', value: balance.totalEquity[0], prev: balance.totalEquity[1] },
                    ]}
                    color={C.sales} format={formatDop} />
                  <Legend items={[
                    { label: <span className="capitalize">{period.label}</span>, color: C.sales },
                    { label: <span className="capitalize">{cmpRef.label}</span>, color: 'rgb(var(--ink-100))' },
                  ]} />
                </>
              ) : (
                <div className="flex flex-col sm:flex-row items-center gap-5">
                  <Donut size={140} thickness={18}
                    segments={[
                      { value: balance.totalLiabilities[0], color: C.expense },
                      { value: balance.totalEquity[0], color: C.income },
                    ]}>
                    <div className="eyebrow-xs text-ink-400">Activos</div>
                    <div className="text-xs font-semibold tabular-nums">{formatDop(balance.totalAssets[0])}</div>
                  </Donut>
                  <ul className="flex-1 min-w-0 space-y-2 w-full">
                    <li className="flex items-center gap-2 text-sm min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: C.expense }} />
                      <span className="text-ink-600 flex-1 min-w-0">Pasivos (financiado por terceros)</span>
                      <span className="tabular-nums font-medium text-ink-800 shrink-0">{formatDop(balance.totalLiabilities[0])}</span>
                    </li>
                    <li className="flex items-center gap-2 text-sm min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: C.income }} />
                      <span className="text-ink-600 flex-1 min-w-0">Patrimonio (capital propio)</span>
                      <span className="tabular-nums font-medium text-ink-800 shrink-0">{formatDop(balance.totalEquity[0])}</span>
                    </li>
                    <li className="text-xs text-ink-400 pt-1">Estructura de financiamiento del activo.</li>
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {/* KPI band — the P&L headline figures with delta vs the comparison. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 my-4 min-w-0">
            <StatKpi label="Ingresos" amounts={income.totalIncome} showDelta={showDelta} vs={vsLabel} />
            <StatKpi label="Utilidad bruta" amounts={income.grossProfit} tone showDelta={showDelta} vs={vsLabel} />
            <StatKpi label="Gastos" amounts={income.totalExpenses} showDelta={showDelta} vs={vsLabel} />
            <StatKpi label="Utilidad neta" amounts={income.netIncome} tone showDelta={showDelta} vs={vsLabel} />
          </div>

          {view === 'table' ? (
            <div className="card p-4 overflow-x-auto min-w-0">
              <table className="w-full">
                <StatementHead periods={income.periods} showDelta={showDelta} />
                <tbody>
                  <SectionRow title="Ingresos" colCount={colCount} first />
                  <AmountRows node={income.income} showDelta={showDelta} />
                  <TotalRow label="Total ingresos" amounts={income.totalIncome} showDelta={showDelta} />

                  <SectionRow title="Costos" colCount={colCount} />
                  <AmountRows node={income.costs} showDelta={showDelta} />
                  <TotalRow label="Utilidad bruta" amounts={income.grossProfit} showDelta={showDelta} />

                  <SectionRow title="Gastos" colCount={colCount} />
                  <AmountRows node={income.expenses} showDelta={showDelta} />
                  <TotalRow label="Total gastos" amounts={income.totalExpenses} showDelta={showDelta} />

                  <TotalRow label="Utilidad neta del período" amounts={income.netIncome} strong showDelta={showDelta} />
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-4 min-w-0">
              <div className="card p-4 min-w-0">
                <h2 className="eyebrow font-semibold text-ink-600 mb-3">Puente de resultado · <span className="capitalize">{period.label}</span></h2>
                <Waterfall
                  steps={[
                    { label: 'Ingresos', value: income.totalIncome[0], total: true },
                    { label: 'Costo', value: -income.totalCosts[0] },
                    { label: 'Gastos', value: -income.totalExpenses[0] },
                    { label: 'Utilidad', value: income.netIncome[0], total: true },
                  ]}
                  colors={{ increase: C.income, decrease: C.expense, total: 'rgb(var(--ink-400))' }}
                  format={formatDop} />
              </div>
              {showDelta && (
                <div className="card p-4 min-w-0">
                  <h2 className="eyebrow font-semibold text-ink-600 mb-3">Comparativo</h2>
                  <YoYColumns
                    data={[
                      { label: 'Ingresos', value: income.totalIncome[0], prev: income.totalIncome[1] },
                      { label: 'U. bruta', value: income.grossProfit[0], prev: income.grossProfit[1] },
                      { label: 'Gastos', value: income.totalExpenses[0], prev: income.totalExpenses[1] },
                      { label: 'U. neta', value: income.netIncome[0], prev: income.netIncome[1] },
                    ]}
                    color={C.sales} format={formatDop} />
                  <Legend items={[
                    { label: <span className="capitalize">{period.label}</span>, color: C.sales },
                    { label: <span className="capitalize">{cmpRef.label}</span>, color: 'rgb(var(--ink-100))' },
                  ]} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </AccountingGate>
  );
}
