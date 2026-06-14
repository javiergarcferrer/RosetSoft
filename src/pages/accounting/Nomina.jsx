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
import { userMessageFor } from '../../lib/errorMessages.js';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';

const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Customizable columns (Shopify-style show/hide, persisted per browser) for the
// two desktop tables. Each `cell` is a pure render off the per-row ctx; the
// preview's `foot` keeps the totals tfoot column-aligned when columns toggle.
const PREVIEW_COLUMNS = [
  { key: 'name', label: 'Empleado', canHide: false, thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3', cell: ({ it }) => it.name, foot: ({ items }) => `${items.length} empleados`, footClass: 'py-2 px-3' },
  { key: 'gross', label: 'Salario', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums', cell: ({ it }) => formatDop(it.gross), foot: ({ totals }) => formatDop(totals.gross), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'sfs', label: 'SFS', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums text-ink-600', cell: ({ it }) => formatDop(it.sfsEmp), foot: ({ items }) => formatDop(items.reduce((s, it) => s + (it.sfsEmp || 0), 0)), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'afp', label: 'AFP', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums text-ink-600', cell: ({ it }) => formatDop(it.afpEmp), foot: ({ items }) => formatDop(items.reduce((s, it) => s + (it.afpEmp || 0), 0)), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'isr', label: 'ISR', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums text-ink-600', cell: ({ it }) => formatDop(it.isr), foot: ({ totals }) => formatDop(totals.isr), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'net', label: 'Neto', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums font-medium', cell: ({ it }) => formatDop(it.net), foot: ({ totals }) => formatDop(totals.net), footClass: 'py-2 px-3 text-right tabular-nums' },
];
const PREVIEW_DEFAULT = { gross: true, sfs: true, afp: true, isr: true, net: true };
const PREVIEW_COLS_KEY = 'rs.nomina.preview.cols.v1';

const RUNS_COLUMNS = [
  { key: 'period', label: 'Período', canHide: false, thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3', cell: ({ r }) => <>{MONTHS_ES[(r.periodMonth || 1) - 1]} {r.periodYear}</> },
  { key: 'paid', label: 'Pagada', thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3 text-ink-500', cell: ({ r }) => formatDate(r.paidAt) },
  { key: 'gross', label: 'Bruto', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums', cell: ({ r }) => formatDop(r.gross) },
  { key: 'isr', label: 'ISR', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums', cell: ({ r }) => formatDop(r.isr) },
  { key: 'net', label: 'Neto', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums font-medium', cell: ({ r }) => formatDop(r.net) },
];
const RUNS_DEFAULT = { paid: true, gross: true, isr: true, net: true };
const RUNS_COLS_KEY = 'rs.nomina.runs.cols.v1';

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

  const previewCols = useColumns(PREVIEW_COLUMNS, PREVIEW_DEFAULT, PREVIEW_COLS_KEY);
  const runsCols = useColumns(RUNS_COLUMNS, RUNS_DEFAULT, RUNS_COLS_KEY);
  const {
    tableRef: previewTableRef, tableStyle: previewTableStyle, thProps: previewThProps,
    ResizeHandle: PreviewResizeHandle, reset: resetPreviewWidths,
  } = useColumnWidths(previewCols.cols, 'rs.nomina.preview.widths.v1');
  const {
    tableRef: runsTableRef, tableStyle: runsTableStyle, thProps: runsThProps,
    ResizeHandle: RunsResizeHandle, reset: resetRunsWidths,
  } = useColumnWidths(runsCols.cols, 'rs.nomina.runs.widths.v1');

  const today = useMemo(() => new Date(), []);
  const [date, setDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10));
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');

  const items = useMemo(() => empQ.data
    .filter((e) => e.active !== false && (e.monthlySalary || 0) > 0)
    .map((e) => ({ employeeId: e.id, name: e.name, ...computePayrollItem(e.monthlySalary) })),
    [empQ.data]);
  const totals = useMemo(() => payrollTotals(items), [items]);

  // A payroll run can't be voided/undone, so a posted period is final — guard
  // against posting the same month twice (a second click, or a return visit
  // since the form defaults to the current month) which would double-count
  // salaries/TSS/ISR in the ledger, IT-1 and dashboards.
  const period = useMemo(() => {
    const d = new Date(date);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }, [date]);
  const existingRun = useMemo(
    () => runsQ.data.find((r) => r.periodYear === period.year && r.periodMonth === period.month),
    [runsQ.data, period],
  );

  async function post() {
    setErr('');
    if (items.length === 0) { setErr('No hay empleados activos con salario.'); return; }
    if (existingRun) { setErr(`La nómina de ${MONTHS_ES[period.month - 1]} ${period.year} ya fue registrada (#${existingRun.number}).`); return; }
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
      setErr(userMessageFor(e));
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
              <button type="button" onClick={post} disabled={posting || items.length === 0 || !!existingRun}
                className="btn-primary ml-auto">
                {posting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                {existingRun ? ' Nómina registrada' : ' Registrar nómina'}
              </button>
            </div>
            {existingRun && !err && (
              <p className="text-sm text-ink-500 mb-2">
                La nómina de {MONTHS_ES[period.month - 1]} {period.year} ya fue registrada (#{existingRun.number}).
              </p>
            )}
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
                <div className="hidden sm:block">
                  <div className="hidden md:flex justify-end mb-2">
                    <ColumnsMenu columns={previewCols.columns} visible={previewCols.visible} onChange={previewCols.setVisible} onReset={() => { previewCols.reset(); resetPreviewWidths(); }} />
                  </div>
                  <div className="overflow-x-auto">
                    <table ref={previewTableRef} style={previewTableStyle} className="w-full text-sm">
                      <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                        <tr>{previewCols.cols.map((c) => <th key={c.key} className={c.thClass} {...previewThProps(c.key)}>{c.label}{PreviewResizeHandle(c.key)}</th>)}</tr>
                      </thead>
                      <tbody>
                        {items.map((it) => {
                          const ctx = { it };
                          return (
                            <tr key={it.employeeId} className="border-t border-ink-50">
                              {previewCols.cols.map((c) => <td key={c.key} className={c.tdClass}>{c.cell(ctx)}</td>)}
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-ink-200 font-semibold">
                          {previewCols.cols.map((c) => <td key={c.key} className={c.footClass}>{c.foot?.({ items, totals })}</td>)}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
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
              <div className="hidden sm:block">
                <div className="hidden md:flex justify-end mb-2 px-3">
                  <ColumnsMenu columns={runsCols.columns} visible={runsCols.visible} onChange={runsCols.setVisible} onReset={() => { runsCols.reset(); resetRunsWidths(); }} />
                </div>
                <div className="overflow-x-auto">
                  <table ref={runsTableRef} style={runsTableStyle} className="w-full text-sm mt-2">
                    <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                      <tr>{runsCols.cols.map((c) => <th key={c.key} className={c.thClass} {...runsThProps(c.key)}>{c.label}{RunsResizeHandle(c.key)}</th>)}</tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => {
                        const ctx = { r };
                        return (
                          <tr key={r.id} className="border-t border-ink-50">
                            {runsCols.cols.map((c) => <td key={c.key} className={c.tdClass}>{c.cell(ctx)}</td>)}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </AccountingGate>
  );
}
