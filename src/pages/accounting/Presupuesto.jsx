import { Fragment, useMemo, useState } from 'react';
import { Target } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { resolveBudgetVariance } from '../../core/accounting/index.js';

const CLASS_LABEL = { 4: 'Ingresos', 5: 'Costos', 6: 'Gastos' };

/**
 * Presupuesto vs. real — set an annual budget per income/cost/expense account
 * and see it against the ledger actual for the year, with the variance colored
 * favorable/unfavorable. Self-gates on accounting/admin.
 */
export default function Presupuesto() {
  const { profileId } = useApp();
  const scope = profileId || 'team';
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);

  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const entriesQ = useLiveQueryStatus(() => db.journalEntries.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.journalLines.where('profileId').equals(scope).toArray(), [scope], []);
  const budgetsQ = useLiveQueryStatus(() => db.budgets.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded && budgetsQ.loaded;

  const variance = useMemo(
    () => resolveBudgetVariance({ accounts: accountsQ.data, lines: linesQ.data, entries: entriesQ.data, budgets: budgetsQ.data, year }),
    [accountsQ.data, linesQ.data, entriesQ.data, budgetsQ.data, year],
  );
  const vmByCode = useMemo(() => new Map(variance.sections.flatMap((s) => s.rows).map((r) => [r.code, r])), [variance]);
  const subtotal = useMemo(() => new Map(variance.sections.map((s) => [s.class, s])), [variance]);

  const groups = useMemo(() => {
    const acc = (accountsQ.data || []).filter((a) => a.isPostable && [4, 5, 6].includes(a.class)).sort((a, b) => a.code.localeCompare(b.code));
    return [4, 5, 6].map((cls) => ({ class: cls, label: CLASS_LABEL[cls], accounts: acc.filter((a) => a.class === cls) })).filter((g) => g.accounts.length);
  }, [accountsQ.data]);

  const [draft, setDraft] = useState({}); // accountCode -> string while editing
  const [saveErr, setSaveErr] = useState('');

  async function saveBudget(code, value) {
    setSaveErr('');
    const amount = Math.round((Number(value) || 0) * 100) / 100;
    try {
      await db.budgets.put({ id: `budget-${year}-${code}`, profileId: scope, year, accountCode: code, amount, updatedAt: Date.now() });
      setDraft((d) => { const n = { ...d }; delete n[code]; return n; });
    } catch (e) {
      // A denied/blocked write must surface — never let the budget silently
      // fail to save while the field shows the typed value.
      setSaveErr(userMessageFor(e));
    }
  }

  const years = [];
  for (let y = thisYear + 1; y >= thisYear - 3; y--) years.push(y);

  return (
    <AccountingGate title="Presupuesto">
      <PageHeader title="Presupuesto vs. real" subtitle="Plan anual por cuenta contra el real del mayor — valores en RD$"
        actions={(
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Año del presupuesto" className="input">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )} />

      {!loaded ? <ListLoading /> : groups.length === 0 ? (
        <EmptyState icon={Target} title="Sin cuentas de resultados"
          description="El catálogo no tiene cuentas imputables de ingresos, costos o gastos para presupuestar." />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">Presupuesto (utilidad)</div><div className="font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(variance.netBudget)}</div></div>
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">Real (utilidad)</div><div className="font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(variance.netActual)}</div></div>
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">Variación</div><div className={`font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto ${variance.netVariance >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatDop(variance.netVariance)}</div></div>
          </div>

          {saveErr && <p className="text-sm text-rose-600 mb-3">{saveErr}</p>}

          <div className="card p-4 overflow-x-auto min-w-0">
            <table className="w-full">
              <caption className="sr-only">Presupuesto anual vs. real por cuenta de ingresos, costos y gastos</caption>
              <thead>
                <tr className="border-b border-ink-200">
                  <th scope="col" className="py-2 pr-3 text-left eyebrow-xs font-semibold text-ink-500">Cuenta</th>
                  <th scope="col" className="py-2 px-3 text-right eyebrow-xs font-semibold text-ink-500">Presupuesto</th>
                  <th scope="col" className="py-2 px-3 text-right eyebrow-xs font-semibold text-ink-500">Real</th>
                  <th scope="col" className="py-2 pl-3 text-right eyebrow-xs font-semibold text-ink-500">Variación</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const st = subtotal.get(g.class) || { budget: 0, actual: 0, variance: 0 };
                  return (
                    <Fragment key={g.class}>
                      <tr><td colSpan={4} className="pt-4 pb-1"><span className="eyebrow font-semibold text-ink-600">{g.label}</span></td></tr>
                      {g.accounts.map((a) => {
                        const vm = vmByCode.get(a.code);
                        const actual = vm?.actual ?? 0;
                        const variance2 = vm?.variance ?? 0;
                        return (
                          <tr key={a.code} className="border-b border-ink-50 last:border-0">
                            <td className="py-1.5 pr-3 text-sm text-ink-700 min-w-[160px]"><code className="text-[11px] text-ink-400 mr-1 tabular-nums">{a.code}</code>{a.name}</td>
                            <td className="py-1.5 px-3 text-right">
                              <input type="number" step="0.01" inputMode="decimal"
                                value={draft[a.code] ?? (vm?.budget ? String(vm.budget) : '')}
                                onChange={(e) => setDraft((d) => ({ ...d, [a.code]: e.target.value }))}
                                onBlur={(e) => { if (draft[a.code] !== undefined) saveBudget(a.code, e.target.value); }}
                                className="input w-32 text-right tabular-nums py-1" placeholder="0.00" />
                            </td>
                            <td className="py-1.5 px-3 text-right text-sm tabular-nums whitespace-nowrap">{formatDop(actual)}</td>
                            <td className={`py-1.5 pl-3 text-right text-sm tabular-nums whitespace-nowrap ${variance2 === 0 ? 'text-ink-400' : vm?.favorable ? 'text-emerald-700' : 'text-rose-700'}`}>{formatDop(variance2)}</td>
                          </tr>
                        );
                      })}
                      <tr className="border-t border-ink-200 font-semibold">
                        <td className="py-2 pr-3 text-sm">Total {g.label.toLowerCase()}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-sm">{formatDop(st.budget)}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-sm">{formatDop(st.actual)}</td>
                        <td className="py-2 pl-3 text-right tabular-nums text-sm">{formatDop(st.variance)}</td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AccountingGate>
  );
}
