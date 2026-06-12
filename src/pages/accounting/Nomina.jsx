import { useMemo, useState } from 'react';
import { Wallet, Loader2, Check } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { computePayrollItem, payrollTotals, buildPayrollEntry, resolveAccountingConfig } from '../../core/accounting/index.js';

const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/**
 * Nómina — generate a month's payroll from the active employees (DR TSS + ISR),
 * preview it, and post the asiento. Self-gates on accounting/admin.
 */
export default function Nomina() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const empQ = useLiveQueryStatus(() => db.employees.where('profileId').equals(scope).toArray(), [scope], []);
  const runsQ = useLiveQueryStatus(() => db.payrollRuns.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = empQ.loaded && runsQ.loaded;

  const today = useMemo(() => new Date(), []);
  const [date, setDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10));
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');

  const items = useMemo(() => empQ.data
    .filter((e) => e.active !== false && (e.monthlySalary || 0) > 0)
    .map((e) => ({ employeeId: e.id, name: e.name, ...computePayrollItem(e.monthlySalary) })),
    [empQ.data]);
  const totals = useMemo(() => payrollTotals(items), [items]);

  async function post() {
    setErr('');
    if (items.length === 0) { setErr('No hay empleados activos con salario.'); return; }
    setPosting(true);
    try {
      const id = newId();
      const postedAt = new Date(date).getTime();
      const d = new Date(date);
      const built = buildPayrollEntry({ newId, config, items, postedAt, memo: `Nómina ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()}` });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'payrollRuns', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, periodYear: d.getFullYear(), periodMonth: d.getMonth() + 1,
          paidAt: postedAt, items, ...totals, status: 'posted', journalEntryId: built.entry.id,
        }),
      });
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setPosting(false);
    }
  }

  const runs = runsQ.data.slice().sort((a, b) => (b.paidAt || 0) - (a.paidAt || 0));

  return (
    <AccountingGate title="Nómina">
      <PageHeader title="Nómina" subtitle="Genera la nómina del mes (TSS + ISR) y se asienta sola" />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4">
          <div className="card p-4">
            <div className="flex flex-wrap items-end gap-3 mb-3">
              <div>
                <div className="label">Fecha de pago</div>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input w-auto" />
              </div>
              <button type="button" onClick={post} disabled={posting || items.length === 0}
                className="btn-primary ml-auto">
                {posting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar nómina
              </button>
            </div>
            {err && <p className="text-sm text-rose-600 mb-2">{err}</p>}
            {items.length === 0 ? (
              <EmptyState icon={Wallet} title="Sin empleados activos" description="Agrega empleados con salario en la página de Empleados." />
            ) : (
              /* Mobile: stacked cards; desktop: table */
              <>
                <div className="sm:hidden space-y-3">
                  {items.map((it) => (
                    <div key={it.employeeId} className="rounded-lg border border-ink-100 bg-ink-50/50 px-3 py-2.5 space-y-1.5">
                      <div className="font-medium text-ink-900">{it.name}</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-600">
                        <span>Salario <span className="tabular-nums font-medium text-ink-900">{formatDop(it.gross)}</span></span>
                        <span>Neto <span className="tabular-nums font-semibold text-ink-900">{formatDop(it.net)}</span></span>
                        <span>SFS <span className="tabular-nums">{formatDop(it.sfsEmp)}</span></span>
                        <span>AFP <span className="tabular-nums">{formatDop(it.afpEmp)}</span></span>
                        <span>ISR <span className="tabular-nums">{formatDop(it.isr)}</span></span>
                      </div>
                    </div>
                  ))}
                  <div className="rounded-lg border border-ink-200 bg-ink-100/60 px-3 py-2 text-xs font-semibold flex justify-between gap-2">
                    <span>{items.length} empleados</span>
                    <span>Neto total: <span className="tabular-nums">{formatDop(totals.net)}</span></span>
                  </div>
                </div>
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                      <tr><th className="text-left py-2 px-3">Empleado</th><th className="text-right py-2 px-3">Salario</th><th className="text-right py-2 px-3">SFS</th><th className="text-right py-2 px-3">AFP</th><th className="text-right py-2 px-3">ISR</th><th className="text-right py-2 px-3">Neto</th></tr>
                    </thead>
                    <tbody>
                      {items.map((it) => (
                        <tr key={it.employeeId} className="border-t border-ink-50">
                          <td className="py-1.5 px-3">{it.name}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(it.gross)}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{formatDop(it.sfsEmp)}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{formatDop(it.afpEmp)}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{formatDop(it.isr)}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(it.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-ink-200 font-semibold">
                        <td className="py-2 px-3">{items.length} empleados</td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatDop(totals.gross)}</td>
                        <td className="py-2 px-3 text-right tabular-nums" colSpan={2}>TSS emp. {formatDop(totals.tssEmp)}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatDop(totals.isr)}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatDop(totals.net)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
            {items.length > 0 && (
              <p className="text-xs text-ink-400 mt-2">
                Aportes patronales: SS {formatDop(totals.employerSs)} · INFOTEP {formatDop(totals.employerInfotep)}.
              </p>
            )}
          </div>

          {runs.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 pt-3"><h2 className="eyebrow font-semibold text-ink-600">Nóminas registradas</h2></div>
              {/* Mobile: stacked cards */}
              <div className="sm:hidden px-3 pb-3 mt-2 space-y-2">
                {runs.map((r) => (
                  <div key={r.id} className="rounded-lg border border-ink-100 bg-ink-50/50 px-3 py-2.5 space-y-1">
                    <div className="flex justify-between items-baseline gap-2 flex-wrap">
                      <span className="font-medium text-ink-900">{MONTHS_ES[(r.periodMonth || 1) - 1]} {r.periodYear}</span>
                      <span className="text-xs text-ink-500">{formatDate(r.paidAt)}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-x-2 text-xs text-ink-600">
                      <span>Bruto <span className="tabular-nums text-ink-900">{formatDop(r.gross)}</span></span>
                      <span>ISR <span className="tabular-nums">{formatDop(r.isr)}</span></span>
                      <span>Neto <span className="tabular-nums font-semibold text-ink-900">{formatDop(r.net)}</span></span>
                    </div>
                  </div>
                ))}
              </div>
              {/* Desktop: table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm mt-2">
                  <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                    <tr><th className="text-left py-2 px-3">Período</th><th className="text-left py-2 px-3">Pagada</th><th className="text-right py-2 px-3">Bruto</th><th className="text-right py-2 px-3">ISR</th><th className="text-right py-2 px-3">Neto</th></tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="border-t border-ink-50">
                        <td className="py-1.5 px-3">{MONTHS_ES[(r.periodMonth || 1) - 1]} {r.periodYear}</td>
                        <td className="py-1.5 px-3 text-ink-500">{formatDate(r.paidAt)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(r.gross)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(r.isr)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(r.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </AccountingGate>
  );
}
