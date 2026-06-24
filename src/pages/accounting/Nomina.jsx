import { useMemo, useState } from 'react';
import { Wallet, Loader2, Check } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  computePayrollItem, payrollTotals, buildPayrollEntry, resolveAccountingConfig,
  ratesForPeriod, overtimePay, regaliaPascual, vacationDays, vacationProportionalDays, dailyWage, vacationPay,
  liquidacion, monthsOfService, bonificacionRun, bonificacionCapDays,
  buildRegaliaEntry, buildLiquidacionEntry, buildBonificacionEntry, round2,
} from '../../core/accounting/index.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';

const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const num = (v) => Number(v) || 0;

const TABS = [
  { key: 'mensual', label: 'Mensual' },
  { key: 'regalia', label: 'Regalía' },
  { key: 'bonificacion', label: 'Bonificación' },
  { key: 'vacaciones', label: 'Vacaciones' },
  { key: 'liquidacion', label: 'Liquidación' },
];
const KIND_LABEL = { regalia: 'Regalía', liquidacion: 'Liquidación', bonificacion: 'Bonificación' };

/** Post a run's asiento + persist the payroll_runs row (shared by all kinds). */
async function postPayrollRun({ scope, built, run }) {
  await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
  await db.journalLines.bulkPut(built.lines);
  const id = newId();
  await assignSequenceNumber({
    table: 'payrollRuns', profileId: scope, start: 1,
    build: (n) => ({ id, profileId: scope, number: n, status: 'posted', journalEntryId: built.entry.id, ...run }),
  });
}
const ADJ_KEYS = ['ot35Hours', 'ot100Hours', 'nightHours', 'holidayHours', 'absenceDays', 'bonus', 'otherEarnings', 'deductions'];
const hasAdj = (a) => !!a && ADJ_KEYS.some((k) => num(a[k]));

const TERMINATION_TYPES = [
  { v: 'desahucio', label: 'Desahucio' },
  { v: 'despido_injustificado', label: 'Despido injustificado' },
  { v: 'despido_justificado', label: 'Despido justificado (Art. 88)' },
  { v: 'dimision_justificada', label: 'Dimisión justificada' },
  { v: 'dimision_injustificada', label: 'Dimisión injustificada' },
  { v: 'no_fault', label: 'Sin culpa — enfermedad/fuerza mayor (Art. 82)' },
];

/** Build one preview/run line from an employee + their adjustments + the
 *  period's TSS topes. Overtime is taxable+cotizable, a bono is taxable only. */
function lineFor(emp, adj, rates) {
  const a = adj || {};
  const overtime = overtimePay(emp.monthlySalary, {
    ot35: num(a.ot35Hours), ot100: num(a.ot100Hours), night: num(a.nightHours), holiday: num(a.holidayHours),
  });
  const earnings = [];
  if (overtime) earnings.push({ label: 'Horas extra', amount: overtime, taxable: true, cotizable: true });
  if (num(a.bonus)) earnings.push({ label: 'Bono', amount: num(a.bonus), taxable: true, cotizable: false });
  if (num(a.otherEarnings)) earnings.push({ label: 'Otros ingresos', amount: num(a.otherEarnings), taxable: true, cotizable: true });
  const deductions = num(a.deductions) ? [{ label: 'Deducciones', amount: num(a.deductions) }] : [];
  const computed = computePayrollItem(emp.monthlySalary, { rates, earnings, absenceDays: num(a.absenceDays), deductions });
  return { employeeId: emp.id, name: emp.name, adjustments: a, ...computed };
}

// Customizable columns for the Mensual preview + the registered-runs table.
const PREVIEW_COLUMNS = [
  { key: 'name', label: 'Empleado', canHide: false, thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3', cell: ({ it }) => <>{it.name}{hasAdj(it.adjustments) && <span title="Con ajustes" className="ml-1 text-brand-600">•</span>}</>, foot: ({ items }) => `${items.length} empleados`, footClass: 'py-2 px-3' },
  { key: 'gross', label: 'Bruto', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums', cell: ({ it }) => formatDop(it.gross), foot: ({ totals }) => formatDop(totals.gross), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'sfs', label: 'SFS', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums text-ink-600', cell: ({ it }) => formatDop(it.sfsEmp), foot: ({ items }) => formatDop(items.reduce((s, it) => s + (it.sfsEmp || 0), 0)), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'afp', label: 'AFP', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums text-ink-600', cell: ({ it }) => formatDop(it.afpEmp), foot: ({ items }) => formatDop(items.reduce((s, it) => s + (it.afpEmp || 0), 0)), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'isr', label: 'ISR', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums text-ink-600', cell: ({ it }) => formatDop(it.isr), foot: ({ totals }) => formatDop(totals.isr), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'ded', label: 'Otras ded.', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums text-ink-600', cell: ({ it }) => formatDop(it.otherDeductions || 0), foot: ({ totals }) => formatDop(totals.otherDeductions || 0), footClass: 'py-2 px-3 text-right tabular-nums' },
  { key: 'net', label: 'Neto', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums font-medium', cell: ({ it }) => formatDop(it.net), foot: ({ totals }) => formatDop(totals.net), footClass: 'py-2 px-3 text-right tabular-nums' },
];
const PREVIEW_DEFAULT = { gross: true, sfs: true, afp: true, isr: true, ded: false, net: true };
const PREVIEW_COLS_KEY = 'rs.nomina.preview.cols.v2';

const RUNS_COLUMNS = [
  { key: 'period', label: 'Período', canHide: false, thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3', cell: ({ r }) => <>{MONTHS_ES[(r.periodMonth || 1) - 1]} {r.periodYear}{KIND_LABEL[r.kind] && <span className="ml-1.5 text-[10px] uppercase tracking-wide rounded bg-ink-100 text-ink-500 px-1.5 py-0.5">{KIND_LABEL[r.kind]}</span>}</>, },
  { key: 'paid', label: 'Pagada', thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3 text-ink-500', cell: ({ r }) => formatDate(r.paidAt) },
  { key: 'gross', label: 'Bruto', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums', cell: ({ r }) => formatDop(r.gross) },
  { key: 'isr', label: 'ISR', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums', cell: ({ r }) => formatDop(r.isr) },
  { key: 'net', label: 'Neto', thClass: 'text-right py-2 px-3', tdClass: 'py-1.5 px-3 text-right tabular-nums font-medium', cell: ({ r }) => formatDop(r.net) },
];
const RUNS_DEFAULT = { paid: true, gross: true, isr: true, net: true };
const RUNS_COLS_KEY = 'rs.nomina.runs.cols.v1';

/** A labelled numeric input used across the calculators. */
function NumIn({ value, onChange, placeholder, className = '' }) {
  return (
    <input type="number" step="0.01" min="0" inputMode="decimal" value={value ?? ''}
      onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className={`input text-right tabular-nums ${className}`} />
  );
}

/**
 * Nómina — the payroll workspace. Mensual generates and posts the month's run
 * (TSS + ISR) with per-employee adjustments (overtime, absences, bono,
 * deductions); the Regalía, Vacaciones and Liquidación tabs are DR calculators
 * (Código de Trabajo). Self-gates on accounting/admin.
 */
export default function Nomina() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const empQ = useLiveQueryStatus(() => db.employees.where('profileId').equals(scope).toArray(), [scope], []);
  const runsQ = useLiveQueryStatus(() => db.payrollRuns.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = empQ.loaded && runsQ.loaded;

  const [tab, setTab] = useState('mensual');
  const activeEmployees = useMemo(
    () => empQ.data.filter((e) => e.active !== false && (e.monthlySalary || 0) > 0),
    [empQ.data],
  );

  return (
    <AccountingGate title="Nómina">
      <PageHeader title="Nómina" subtitle="Nómina mensual, regalía, vacaciones y liquidación (DR)" />
      {!loaded ? <ListLoading /> : (
        <div>
          <TabPills tabs={TABS} active={tab} onChange={setTab} />

          {activeEmployees.length === 0 && tab !== 'liquidacion' ? (
            <EmptyState icon={Wallet} title="Sin empleados activos" description="Agrega empleados con salario en la página de Empleados." />
          ) : (
            <>
              {tab === 'mensual' && <Mensual scope={scope} config={config} employees={activeEmployees} runs={runsQ.data} />}
              {tab === 'regalia' && <Regalia scope={scope} config={config} employees={activeEmployees} runs={runsQ.data} />}
              {tab === 'bonificacion' && <Bonificacion scope={scope} config={config} employees={activeEmployees} runs={runsQ.data} />}
              {tab === 'vacaciones' && <Vacaciones employees={activeEmployees} />}
              {tab === 'liquidacion' && <Liquidacion scope={scope} config={config} employees={empQ.data} />}
            </>
          )}
        </div>
      )}
    </AccountingGate>
  );
}

// ── Mensual ──────────────────────────────────────────────────────────────────

function Mensual({ scope, config, employees, runs }) {
  const previewCols = useColumns(PREVIEW_COLUMNS, PREVIEW_DEFAULT, PREVIEW_COLS_KEY);
  const runsCols = useColumns(RUNS_COLUMNS, RUNS_DEFAULT, RUNS_COLS_KEY);
  const {
    tableRef: previewTableRef, tableStyle: previewTableStyle, thProps: previewThProps,
    ResizeHandle: PreviewResizeHandle, reset: resetPreviewWidths,
  } = useColumnWidths(previewCols.cols, 'rs.nomina.preview.widths.v2');
  const {
    tableRef: runsTableRef, tableStyle: runsTableStyle, thProps: runsThProps,
    ResizeHandle: RunsResizeHandle, reset: resetRunsWidths,
  } = useColumnWidths(runsCols.cols, 'rs.nomina.runs.widths.v1');

  const today = useMemo(() => new Date(), []);
  const [date, setDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10));
  const [adjustments, setAdjustments] = useState({}); // employeeId → { ...ADJ_KEYS }
  const [selId, setSelId] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');

  // Parse the YYYY-MM-DD parts directly (a UTC-parsed Date rolls the 1st back a
  // month in DR/UTC-4), so the run lands in the month the user picked.
  const period = useMemo(() => { const [year, month] = date.split('-').map(Number); return { year, month }; }, [date]);
  const rates = useMemo(() => ratesForPeriod(period.year, period.month), [period]);

  const items = useMemo(() => employees.map((e) => lineFor(e, adjustments[e.id], rates)), [employees, adjustments, rates]);
  const totals = useMemo(() => payrollTotals(items), [items]);

  // A posted month is final (runs can't be voided) — guard the dup post.
  const existingRun = useMemo(
    () => runs.find((r) => r.periodYear === period.year && r.periodMonth === period.month && (r.kind || 'monthly') === 'monthly'),
    [runs, period],
  );

  const sel = employees.find((e) => e.id === selId) || null;
  const setAdj = (id, patch) => setAdjustments((m) => ({ ...m, [id]: { ...(m[id] || {}), ...patch } }));

  async function post() {
    setErr('');
    if (items.length === 0) { setErr('No hay empleados activos con salario.'); return; }
    if (existingRun) { setErr(`La nómina de ${MONTHS_ES[period.month - 1]} ${period.year} ya fue registrada (#${existingRun.number}).`); return; }
    setPosting(true);
    try {
      const id = newId();
      const postedAt = new Date(date).getTime();
      const built = buildPayrollEntry({ newId, config, items, postedAt, memo: `Nómina ${MONTHS_ES[period.month - 1]} ${period.year}` });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'payrollRuns', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, periodYear: period.year, periodMonth: period.month,
          paidAt: postedAt, items, ...totals, kind: 'monthly', status: 'posted', journalEntryId: built.entry.id,
        }),
      });
      setAdjustments({});
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setPosting(false);
    }
  }

  const sortedRuns = runs.slice().sort((a, b) => (b.paidAt || 0) - (a.paidAt || 0));

  return (
    <>
      <div className="card p-4">
        <div className="flex flex-wrap items-end gap-3 mb-2">
          <div>
            <div className="label">Fecha de pago</div>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input w-auto" />
          </div>
          <button type="button" onClick={post} disabled={posting || items.length === 0 || !!existingRun} className="btn-primary ml-auto">
            {posting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            {existingRun ? ' Nómina registrada' : ' Registrar nómina'}
          </button>
        </div>
        <p className="text-xs text-ink-400 mb-3">
          Topes TSS {MONTHS_ES[period.month - 1]} {period.year}: SFS {formatDop(rates.sfsSalaryCap)} · AFP {formatDop(rates.afpSalaryCap)} · SRL {formatDop(rates.srlSalaryCap)} (salario mínimo cotizable {formatDop(rates.smc)}).
        </p>
        {existingRun && !err && (
          <p className="text-sm text-ink-500 mb-2">La nómina de {MONTHS_ES[period.month - 1]} {period.year} ya fue registrada (#{existingRun.number}).</p>
        )}
        {err && <p className="text-sm text-rose-600 mb-2">{err}</p>}

        {/* Per-employee adjustments */}
        <div className="rounded-lg border border-ink-100 bg-ink-50/40 p-3 mb-3">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="eyebrow font-semibold text-ink-600">Ajustes por empleado</span>
            <select value={selId} onChange={(e) => setSelId(e.target.value)} className="input w-auto ml-auto max-w-[16rem]">
              <option value="">Seleccionar empleado…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{hasAdj(adjustments[e.id]) ? ' •' : ''}</option>)}
            </select>
          </div>
          {sel ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  ['ot35Hours', 'Horas extra 35%'], ['ot100Hours', 'Horas extra 100%'],
                  ['nightHours', 'Horas nocturnas'], ['holidayHours', 'Horas feriado'],
                  ['absenceDays', 'Días no laborados'], ['bonus', 'Bono (gravable)'],
                  ['otherEarnings', 'Otros ingresos'], ['deductions', 'Otras deducciones'],
                ].map(([k, lbl]) => (
                  <label key={k} className="block">
                    <span className="label">{lbl}</span>
                    <NumIn value={(adjustments[selId] || {})[k]} onChange={(v) => setAdj(selId, { [k]: v })} placeholder="0" />
                  </label>
                ))}
              </div>
              <button type="button" onClick={() => setAdjustments((m) => { const n = { ...m }; delete n[selId]; return n; })}
                className="text-xs text-ink-500 hover:text-ink-800 mt-2">Limpiar ajustes</button>
            </>
          ) : (
            <p className="text-xs text-ink-400">Elige un empleado para registrar horas extra, ausencias, bonos o deducciones del mes.</p>
          )}
        </div>

        {/* Mobile cards */}
        <div className="sm:hidden space-y-3">
          {items.map((it) => (
            <div key={it.employeeId} className="rounded-lg border border-ink-100 bg-ink-50/50 px-3 py-2.5 space-y-1.5">
              <div className="font-medium text-ink-900">{it.name}{hasAdj(it.adjustments) && <span className="ml-1 text-brand-600">•</span>}</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-600">
                <span>Bruto <span className="tabular-nums font-medium text-ink-900">{formatDop(it.gross)}</span></span>
                <span>Neto <span className="tabular-nums font-semibold text-ink-900">{formatDop(it.net)}</span></span>
                <span>SFS <span className="tabular-nums">{formatDop(it.sfsEmp)}</span></span>
                <span>AFP <span className="tabular-nums">{formatDop(it.afpEmp)}</span></span>
                <span>ISR <span className="tabular-nums">{formatDop(it.isr)}</span></span>
                {(it.otherDeductions || 0) > 0 && <span>Otras ded. <span className="tabular-nums">{formatDop(it.otherDeductions)}</span></span>}
              </div>
            </div>
          ))}
          <div className="rounded-lg border border-ink-200 bg-ink-100/60 px-3 py-2 text-xs font-semibold flex justify-between gap-2">
            <span>{items.length} empleados</span>
            <span>Neto total: <span className="tabular-nums">{formatDop(totals.net)}</span></span>
          </div>
        </div>
        {/* Desktop table */}
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
                {items.map((it) => (
                  <tr key={it.employeeId} className="border-t border-ink-50">
                    {previewCols.cols.map((c) => <td key={c.key} className={c.tdClass}>{c.cell({ it })}</td>)}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-200 font-semibold">
                  {previewCols.cols.map((c) => <td key={c.key} className={c.footClass}>{c.foot?.({ items, totals })}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        {items.length > 0 && (
          <p className="text-xs text-ink-400 mt-2">Aportes patronales: SS {formatDop(totals.employerSs)} · INFOTEP {formatDop(totals.employerInfotep)}.</p>
        )}
      </div>

      {sortedRuns.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 pt-3"><h2 className="eyebrow font-semibold text-ink-600">Nóminas registradas</h2></div>
          <div className="sm:hidden px-3 pb-3 mt-2 space-y-2">
            {sortedRuns.map((r) => (
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
                  {sortedRuns.map((r) => (
                    <tr key={r.id} className="border-t border-ink-50">
                      {runsCols.cols.map((c) => <td key={c.key} className={c.tdClass}>{c.cell({ r })}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Regalía pascual ──────────────────────────────────────────────────────────

function Regalia({ scope, config, employees, runs }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  // Salario ordinario devengado en el año, por empleado (default = 12 meses).
  const [ytd, setYtd] = useState({});
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');

  const rows = employees.map((e) => {
    const earned = ytd[e.id] != null && ytd[e.id] !== '' ? num(ytd[e.id]) : (e.monthlySalary || 0) * 12;
    return { e, earned, r: regaliaPascual(earned) };
  });
  const total = round2(rows.reduce((s, x) => s + x.r.amount, 0));
  const existing = runs.find((r) => r.kind === 'regalia' && r.periodYear === Number(year));

  async function post() {
    setErr('');
    if (total <= 0) { setErr('No hay montos de regalía.'); return; }
    if (existing) { setErr(`La regalía de ${year} ya fue registrada (#${existing.number}).`); return; }
    setPosting(true);
    try {
      const postedAt = new Date(Number(year), 11, 20).getTime(); // 20 de diciembre
      const built = buildRegaliaEntry({ newId, config, gross: total, isr: 0, postedAt, memo: `Regalía pascual ${year}` });
      const items = rows.map(({ e, r }) => ({ employeeId: e.id, name: e.name, gross: r.amount, isr: 0, net: r.amount }));
      await postPayrollRun({ scope, built, run: { periodYear: Number(year), periodMonth: 12, paidAt: postedAt, items, gross: total, tssEmp: 0, isr: 0, net: total, employerSs: 0, employerInfotep: 0, otherDeductions: 0, kind: 'regalia' } });
    } catch (e) { setErr(userMessageFor(e)); } finally { setPosting(false); }
  }

  return (
    <div className="card p-4 space-y-3">
      <p className="text-xs text-ink-400">
        Regalía pascual (salario de Navidad) = 1/12 del salario ordinario del año. Exenta de ISR y TSS hasta ese 1/12; pagar a más tardar el 20 de diciembre (Arts. 219–222).
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">Año</span>
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} className="input w-28 tabular-nums" />
        </label>
        <button type="button" onClick={post} disabled={posting || total <= 0 || !!existing} className="btn-primary ml-auto">
          {posting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
          {existing ? ' Regalía registrada' : ' Registrar regalía'}
        </button>
      </div>
      {existing && !err && <p className="text-sm text-ink-500">La regalía de {year} ya fue registrada (#{existing.number}).</p>}
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {/* Mobile cards */}
      <div className="sm:hidden space-y-3">
        {rows.map(({ e, earned, r }) => (
          <div key={e.id} className="rounded-lg border border-ink-100 bg-ink-50/50 px-3 py-2.5 space-y-1.5">
            <div className="font-medium text-ink-900">{e.name}</div>
            <label className="flex items-center justify-between gap-2 text-xs text-ink-600">Salario del año
              <NumIn value={ytd[e.id] ?? ''} onChange={(v) => setYtd((m) => ({ ...m, [e.id]: v }))} placeholder={String(earned)} className="w-36" />
            </label>
            <div className="grid grid-cols-3 gap-x-2 text-xs text-ink-600">
              <span>Regalía <span className="tabular-nums font-medium text-ink-900">{formatDop(r.amount)}</span></span>
              <span>Exento <span className="tabular-nums">{formatDop(r.isrExempt)}</span></span>
              <span>Gravado <span className="tabular-nums">{formatDop(r.isrTaxable)}</span></span>
            </div>
          </div>
        ))}
        <div className="rounded-lg border border-ink-200 bg-ink-100/60 px-3 py-2 text-xs font-semibold flex justify-between gap-2">
          <span>{rows.length} empleados</span>
          <span>Total: <span className="tabular-nums">{formatDop(total)}</span></span>
        </div>
      </div>
      {/* Desktop table */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left py-2 px-3">Empleado</th>
              <th className="text-right py-2 px-3">Salario del año</th>
              <th className="text-right py-2 px-3">Regalía</th>
              <th className="text-right py-2 px-3">Exento</th>
              <th className="text-right py-2 px-3">Gravado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, earned, r }) => (
              <tr key={e.id} className="border-t border-ink-50">
                <td className="py-1.5 px-3">{e.name}</td>
                <td className="py-1.5 px-3 text-right"><NumIn value={ytd[e.id] ?? ''} onChange={(v) => setYtd((m) => ({ ...m, [e.id]: v }))} placeholder={String(earned)} className="w-32" /></td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(r.amount)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{formatDop(r.isrExempt)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{formatDop(r.isrTaxable)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-ink-200 font-semibold">
              <td className="py-2 px-3">{rows.length} empleados</td>
              <td></td>
              <td className="py-2 px-3 text-right tabular-nums">{formatDop(total)}</td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ── Vacaciones ───────────────────────────────────────────────────────────────

function Vacaciones({ employees }) {
  const [days, setDays] = useState({}); // override días
  const rows = employees.map((e) => {
    const months = e.hireAt ? monthsOfService(e.hireAt, Date.now()) : 0;
    const years = months / 12;
    // Under a year accrues proportionally from month 5 (Art. 180); 14/18 días
    // from year 1 (Art. 177). Was always vacationDays(floor(years)) → 0 días for
    // first-year staff, silently under-paying the proportional entitlement.
    const defDays = years >= 1 ? vacationDays(Math.floor(years)) : vacationProportionalDays(months);
    const d = days[e.id] != null && days[e.id] !== '' ? num(days[e.id]) : defDays;
    return { e, years, defDays, d, daily: dailyWage(e.monthlySalary), pay: vacationPay(e.monthlySalary, d) };
  });
  const total = rows.reduce((s, x) => s + x.pay, 0);

  return (
    <div className="card p-4 space-y-3">
      <p className="text-xs text-ink-400">
        Vacaciones (Art. 177): 14 días laborables de 1 a 5 años de servicio, 18 días a partir de 5 años; en el primer año se acumulan proporcionalmente desde los 5 meses (Art. 180). Salario diario = salario ÷ 23.83. La antigüedad se calcula desde la fecha de ingreso del empleado.
      </p>
      {/* Mobile cards */}
      <div className="sm:hidden space-y-3">
        {rows.map(({ e, years, defDays, daily, pay }) => (
          <div key={e.id} className="rounded-lg border border-ink-100 bg-ink-50/50 px-3 py-2.5 space-y-1.5">
            <div className="flex justify-between items-baseline gap-2 flex-wrap">
              <span className="font-medium text-ink-900">{e.name}</span>
              <span className="text-xs text-ink-500 tabular-nums">{e.hireAt ? `${years.toFixed(1)} años` : '—'}</span>
            </div>
            <label className="flex items-center justify-between gap-2 text-xs text-ink-600">Días
              <NumIn value={days[e.id] ?? ''} onChange={(v) => setDays((m) => ({ ...m, [e.id]: v }))} placeholder={String(defDays)} className="w-20" />
            </label>
            <div className="grid grid-cols-2 gap-x-4 text-xs text-ink-600">
              <span>Salario diario <span className="tabular-nums">{formatDop(daily)}</span></span>
              <span>A pagar <span className="tabular-nums font-medium text-ink-900">{formatDop(pay)}</span></span>
            </div>
          </div>
        ))}
        <div className="rounded-lg border border-ink-200 bg-ink-100/60 px-3 py-2 text-xs font-semibold flex justify-between gap-2">
          <span>{rows.length} empleados</span>
          <span>Total: <span className="tabular-nums">{formatDop(total)}</span></span>
        </div>
      </div>
      {/* Desktop table */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left py-2 px-3">Empleado</th>
              <th className="text-right py-2 px-3">Antigüedad</th>
              <th className="text-right py-2 px-3">Días</th>
              <th className="text-right py-2 px-3">Salario diario</th>
              <th className="text-right py-2 px-3">A pagar</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, years, defDays, daily, pay }) => (
              <tr key={e.id} className="border-t border-ink-50">
                <td className="py-1.5 px-3">{e.name}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{e.hireAt ? `${years.toFixed(1)} años` : '—'}</td>
                <td className="py-1.5 px-3 text-right"><NumIn value={days[e.id] ?? ''} onChange={(v) => setDays((m) => ({ ...m, [e.id]: v }))} placeholder={String(defDays)} className="w-20" /></td>
                <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{formatDop(daily)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(pay)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-ink-200 font-semibold">
              <td className="py-2 px-3">{rows.length} empleados</td>
              <td colSpan={3}></td>
              <td className="py-2 px-3 text-right tabular-nums">{formatDop(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ── Liquidación (prestaciones laborales) ─────────────────────────────────────

function Liquidacion({ scope, config, employees }) {
  const [empId, setEmpId] = useState('');
  const [type, setType] = useState('desahucio');
  const [initiatedBy, setInitiatedBy] = useState('employer');
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [vacDays, setVacDays] = useState('');
  const [ytd, setYtd] = useState('');
  const [isr, setIsr] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  const emp = employees.find((e) => e.id === empId) || null;
  const endMs = useMemo(() => { const [y, m, d] = endDate.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }, [endDate]);
  const result = useMemo(() => {
    if (!emp) return null;
    return liquidacion({
      monthlySalary: emp.monthlySalary, startMs: emp.hireAt || endMs, endMs,
      terminationType: type, initiatedBy,
      pendingVacationDays: num(vacDays),
      ...(ytd !== '' ? { ordinaryEarnedYTD: num(ytd) } : {}),
    });
  }, [emp, endMs, type, initiatedBy, vacDays, ytd]);

  async function post() {
    setErr(''); setDone(false);
    if (!emp || !result || result.total <= 0) { setErr('La liquidación no tiene montos.'); return; }
    setPosting(true);
    try {
      const indemnities = round2(result.preaviso + result.cesantia + result.asistencia);
      const salaryItems = round2(result.vacaciones + result.regalia);
      const built = buildLiquidacionEntry({ newId, config, indemnities, salaryItems, isr: num(isr), postedAt: endMs, memo: `Liquidación ${emp.name}` });
      const [y, m] = endDate.split('-').map(Number);
      const items = [{ employeeId: emp.id, name: emp.name, gross: result.total, isr: num(isr), net: round2(result.total - num(isr)), ...result }];
      await postPayrollRun({ scope, built, run: { periodYear: y, periodMonth: m, paidAt: endMs, items, gross: result.total, tssEmp: 0, isr: num(isr), net: round2(result.total - num(isr)), employerSs: 0, employerInfotep: 0, otherDeductions: 0, kind: 'liquidacion' } });
      setDone(true);
    } catch (e) { setErr(userMessageFor(e)); } finally { setPosting(false); }
  }

  const Row = ({ label, value, sub, strong }) => (
    <div className="flex justify-between gap-3 py-1.5 border-t border-ink-50 first:border-0">
      <span className={strong ? 'font-semibold text-ink-900' : 'text-ink-600'}>{label}{sub && <span className="text-ink-400"> · {sub}</span>}</span>
      <span className={`tabular-nums ${strong ? 'font-semibold text-ink-900' : ''}`}>{formatDop(value)}</span>
    </div>
  );

  return (
    <div className="card p-4 space-y-4">
      <p className="text-xs text-ink-400">
        Liquidación (prestaciones laborales): preaviso (Art. 76) y cesantía (Art. 80) según el tipo de terminación, más los derechos adquiridos (vacaciones proporcionales + regalía proporcional). Preaviso/cesantía/asistencia son exentos de ISR y TSS; las vacaciones son gravables.
      </p>
      <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
        <label className="block">
          <span className="label">Empleado</span>
          <select value={empId} onChange={(e) => setEmpId(e.target.value)} className="input">
            <option value="">Seleccionar…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Tipo de terminación</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="input">
            {TERMINATION_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </label>
        {type === 'desahucio' && (
          <label className="block">
            <span className="label">Iniciado por</span>
            <select value={initiatedBy} onChange={(e) => setInitiatedBy(e.target.value)} className="input">
              <option value="employer">Empleador (paga cesantía)</option>
              <option value="worker">Trabajador (sin cesantía)</option>
            </select>
          </label>
        )}
        <label className="block">
          <span className="label">Fecha de salida</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="input" />
        </label>
        <label className="block">
          <span className="label">Días de vacaciones pendientes</span>
          <NumIn value={vacDays} onChange={setVacDays} placeholder="0" />
        </label>
        <label className="block">
          <span className="label">Salario ordinario del año (regalía)</span>
          <NumIn value={ytd} onChange={setYtd} placeholder={emp ? `auto: ${(emp.monthlySalary || 0) * (new Date(endMs).getMonth() + 1)}` : 'auto'} />
        </label>
      </div>

      {!emp ? (
        <p className="text-sm text-ink-400">Selecciona un empleado para calcular la liquidación.</p>
      ) : result && (
        <div className="rounded-lg border border-ink-100 bg-ink-50/40 p-4 max-w-md">
          <div className="text-sm text-ink-500 mb-2">{emp.name} · {result.months} meses de servicio · salario diario {formatDop(result.daily)}</div>
          <Row label="Preaviso" sub={`${result.preavisoDays} días`} value={result.preaviso} />
          <Row label="Cesantía" sub={`${result.cesantiaDays} días`} value={result.cesantia} />
          {result.asistencia > 0 && <Row label="Asistencia económica" sub={`${result.asistenciaDays} días`} value={result.asistencia} />}
          <Row label="Vacaciones" value={result.vacaciones} />
          <Row label="Regalía proporcional" value={result.regalia} />
          <Row label="Total" value={result.total} strong />
          <div className="mt-2 pt-2 border-t border-ink-100 text-xs text-ink-500 flex justify-between gap-3">
            <span>Exento ISR/TSS: <span className="tabular-nums">{formatDop(result.exempt)}</span></span>
            <span>Gravable: <span className="tabular-nums">{formatDop(result.taxable)}</span></span>
          </div>
          <div className="mt-3 pt-3 border-t border-ink-100 flex items-end gap-3">
            <label className="block">
              <span className="label">Retención ISR (opcional)</span>
              <NumIn value={isr} onChange={setIsr} placeholder="0" className="w-32" />
            </label>
            <button type="button" onClick={post} disabled={posting} className="btn-primary ml-auto">
              {posting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar liquidación
            </button>
          </div>
          {done && !err && <p className="text-sm text-emerald-600 mt-2">Liquidación registrada.</p>}
          {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
        </div>
      )}
    </div>
  );
}

// ── Bonificación / participación en los beneficios ───────────────────────────

function Bonificacion({ scope, config, employees, runs }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [profits, setProfits] = useState('');
  const [isr, setIsr] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');

  const workers = employees.map((e) => ({
    id: e.id, name: e.name, salary: e.monthlySalary,
    years: e.hireAt ? monthsOfService(e.hireAt, Date.now()) / 12 : 0,
  }));
  const run = useMemo(() => bonificacionRun(num(profits), workers), [profits, workers]);
  const infotep = round2(run.total * 0.005); // 0.5% INFOTEP empleado sobre bonos
  const net = round2(run.total - num(isr) - infotep);
  const existing = runs.find((r) => r.kind === 'bonificacion' && r.periodYear === Number(year));

  async function post() {
    setErr('');
    if (run.total <= 0) { setErr('No hay bonificación que repartir (indica los beneficios netos).'); return; }
    if (existing) { setErr(`La bonificación de ${year} ya fue registrada (#${existing.number}).`); return; }
    setPosting(true);
    try {
      const postedAt = new Date(Number(year), 11, 31).getTime();
      const built = buildBonificacionEntry({ newId, config, gross: run.total, isr: num(isr), infotep, postedAt, memo: `Bonificación ${year}` });
      const items = run.items.map((i) => ({ employeeId: i.id, name: i.name, gross: i.share, isr: 0, net: i.share }));
      await postPayrollRun({ scope, built, run: { periodYear: Number(year), periodMonth: 12, paidAt: postedAt, items, gross: run.total, tssEmp: 0, isr: num(isr), net, employerSs: 0, employerInfotep: 0, otherDeductions: infotep, kind: 'bonificacion' } });
    } catch (e) { setErr(userMessageFor(e)); } finally { setPosting(false); }
  }

  return (
    <div className="card p-4 space-y-3">
      <p className="text-xs text-ink-400">
        Bonificación (participación en los beneficios, Art. 223): 10% de los beneficios netos, repartido por salario y topado a 45 días (&lt;3 años) o 60 días (3+ años). Gravable de ISR (a diferencia de la regalía), fuera del TSS; INFOTEP empleado 0.5%. Pagar entre 90 y 120 días tras el cierre.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">Año</span>
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} className="input w-28 tabular-nums" />
        </label>
        <label className="block">
          <span className="label">Beneficios netos del año</span>
          <NumIn value={profits} onChange={setProfits} placeholder="0" className="w-44" />
        </label>
        <div className="text-sm text-ink-500">Masa a repartir (10%): <span className="tabular-nums font-medium text-ink-800">{formatDop(run.pool)}</span></div>
        <button type="button" onClick={post} disabled={posting || run.total <= 0 || !!existing} className="btn-primary ml-auto">
          {posting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
          {existing ? ' Bonificación registrada' : ' Registrar bonificación'}
        </button>
      </div>
      {existing && !err && <p className="text-sm text-ink-500">La bonificación de {year} ya fue registrada (#{existing.number}).</p>}
      {err && <p className="text-sm text-rose-600">{err}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left py-2 px-3">Empleado</th>
              <th className="text-right py-2 px-3">Salario</th>
              <th className="text-right py-2 px-3">Años</th>
              <th className="text-right py-2 px-3">Tope</th>
              <th className="text-right py-2 px-3">Bonificación</th>
            </tr>
          </thead>
          <tbody>
            {run.items.map((i) => (
              <tr key={i.id} className="border-t border-ink-50">
                <td className="py-1.5 px-3">{i.name}{i.share < i.raw && <span title="Topado" className="ml-1 text-amber-600">▲</span>}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{formatDop(i.salary)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-ink-600">{(i.years || 0).toFixed(1)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-ink-500">{bonificacionCapDays(i.years)} días</td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(i.share)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-ink-200 font-semibold">
              <td className="py-2 px-3">{run.items.length} empleados</td>
              <td colSpan={3}></td>
              <td className="py-2 px-3 text-right tabular-nums">{formatDop(run.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="block">
          <span className="label">Retención ISR (opcional)</span>
          <NumIn value={isr} onChange={setIsr} placeholder="0" className="w-32" />
        </label>
        <div className="text-ink-500">INFOTEP 0.5%: <span className="tabular-nums">{formatDop(infotep)}</span></div>
        <div className="text-ink-700 font-medium">Neto a pagar: <span className="tabular-nums">{formatDop(net)}</span></div>
      </div>
    </div>
  );
}
