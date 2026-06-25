import { userMessageFor } from '../../lib/errorMessages.js';
import { useMemo, useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { BookOpen, Plus, Trash2, Loader2, Check, X, RotateCcw, Download } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import RowCards from '../../components/RowCards.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import AccountTree from '../../components/accounting/AccountTree.jsx';
import { useConfirm } from '../../components/ConfirmProvider.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import { downloadCsv } from '../../lib/csv.js';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import {
  resolveJournal, resolveTrialBalance, resolveAccountLedger, resolveChartTree, sourceDocHref,
  postableAccounts, assertBalanced, buildJournalEntry, buildReversalEntry, debitTotal, creditTotal,
} from '../../core/accounting/index.js';

/**
 * Libro contable — the general-ledger surface:
 *   • Diario  — every asiento newest-first, plus a "Nuevo asiento" form that
 *               posts a balanced manual entry (the app refuses to save an
 *               unbalanced one, via assertBalanced).
 *   • Mayor   — one account's movements with a running balance.
 *   • Balanza — the trial balance (Σ débito must equal Σ crédito).
 * Self-gates on accounting/admin via AccountingGate.
 */
const SOURCE_LABEL = {
  manual: 'Manual', opening: 'Apertura', sale: 'Venta', purchase: 'Compra',
  expense: 'Gasto', payment: 'Pago', import: 'Importación', payroll: 'Nómina',
  depreciation: 'Depreciación', fx: 'Cambio', tax: 'Impuestos', gateway: 'Pasarela',
  adjustment: 'Ajuste',
};

function emptyLine() { return { accountCode: '', debit: '', credit: '' }; }

/**
 * Customizable desktop columns (Shopify "edit columns" pattern) for the Mayor
 * and Balanza record-list tables. ONE ordered definition drives both the table
 * render (`cell`) and the Columns menu (`label` / `canHide`). The identity/first
 * column is the fixed anchor (`canHide: false`). Each `cell` is pure over the
 * per-row `ctx` bag the row assembles. Defaults mirror the columns each table
 * shipped with. The Diario journal-entry breakdown stays a fixed mini-table —
 * it's a per-asiento line summary, not a record list.
 */

// "Mayor" — one row per movement of the selected account, running balance.
const MAYOR_COLUMNS = [
  {
    key: 'fecha', label: 'Fecha', canHide: false,
    thClass: 'text-left py-2 px-3 whitespace-nowrap',
    tdClass: 'py-1.5 px-3 text-ink-500 whitespace-nowrap',
    cell: ({ line }) => formatDate(line.postedAt),
  },
  {
    key: 'concepto', label: 'Concepto',
    thClass: 'text-left py-2 px-3',
    tdClass: 'py-1.5 px-3 min-w-0',
    cell: ({ line }) => {
      const href = sourceDocHref(line.entryRefTable, line.entryRefId);
      const memo = line.entryMemo || '—';
      return href
        ? <Link to={href} className="text-brand-600 hover:text-brand-700 hover:underline">{memo}</Link>
        : memo;
    },
  },
  {
    key: 'debito', label: 'Débito',
    thClass: 'text-right py-2 px-3 whitespace-nowrap',
    tdClass: 'py-1.5 px-3 text-right tabular-nums whitespace-nowrap',
    cell: ({ line }) => (line.debit ? formatDop(line.debit) : ''),
  },
  {
    key: 'credito', label: 'Crédito',
    thClass: 'text-right py-2 px-3 whitespace-nowrap',
    tdClass: 'py-1.5 px-3 text-right tabular-nums whitespace-nowrap',
    cell: ({ line }) => (line.credit ? formatDop(line.credit) : ''),
  },
  {
    key: 'saldo', label: 'Saldo',
    thClass: 'text-right py-2 px-3 whitespace-nowrap',
    tdClass: 'py-1.5 px-3 text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ balance }) => formatDop(balance),
  },
];
const MAYOR_DEFAULT = { concepto: true, debito: true, credito: true, saldo: true };
const MAYOR_COLS_KEY = 'rs.ledger.mayor.cols.v1';

// "Balanza" — the trial balance, one row per account. Row click drills into the
// Mayor (handler stays fixed on the <tr>, so every cell is pure).
const BALANZA_COLUMNS = [
  {
    key: 'cuenta', label: 'Cuenta', canHide: false,
    thClass: 'text-left py-2 px-3',
    tdClass: 'py-1.5 px-3 min-w-0',
    cell: ({ r }) => (
      <><code className="text-[11px] text-ink-400 mr-2 tabular-nums">{r.code}</code>{r.name}</>
    ),
  },
  {
    key: 'debito', label: 'Débito',
    thClass: 'text-right py-2 px-3 whitespace-nowrap',
    tdClass: 'py-1.5 px-3 text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.debit),
  },
  {
    key: 'credito', label: 'Crédito',
    thClass: 'text-right py-2 px-3 whitespace-nowrap',
    tdClass: 'py-1.5 px-3 text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.credit),
  },
  {
    key: 'saldo', label: 'Saldo',
    thClass: 'text-right py-2 px-3 whitespace-nowrap',
    tdClass: 'py-1.5 px-3 text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ r }) => formatDop(r.balance),
  },
];
const BALANZA_DEFAULT = { debito: true, credito: true, saldo: true };
const BALANZA_COLS_KEY = 'rs.ledger.balanza.cols.v1';

function NewEntryForm({ accounts, profileId, userId, onClose }) {
  const today = useMemo(() => isoDate(Date.now()), []);
  const [date, setDate] = useState(today);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([emptyLine(), emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const options = useMemo(
    () => postableAccounts(accounts).sort((a, b) => a.code.localeCompare(b.code)),
    [accounts],
  );

  const parsed = lines.map((l) => ({
    accountCode: l.accountCode,
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
  }));
  const totDebit = debitTotal(parsed);
  const totCredit = creditTotal(parsed);
  const imbalance = Math.round((totDebit - totCredit) * 100) / 100;

  function setLine(i, patch) {
    setLines((arr) => arr.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function save() {
    setErr('');
    try {
      const payload = parsed.filter((l) => l.accountCode && (l.debit || l.credit));
      assertBalanced(payload);
      setSaving(true);
      const built = buildJournalEntry({
        newId, profileId, postedAt: parseISODate(date), memo: memo.trim(),
        source: 'manual', createdByUserId: userId || null, lines: payload,
      });
      await assignSequenceNumber({
        table: 'journalEntries', profileId, start: 1,
        build: (number) => ({ ...built.entry, number }),
      });
      await db.journalLines.bulkPut(built.lines);
      onClose();
    } catch (e) {
      setErr(userMessageFor(e));
      setSaving(false);
    }
  }

  return (
    <div className="card p-4 mb-4 border-ink-300">
      <div className="flex items-center justify-between mb-3 gap-2 min-w-0">
        <h3 className="font-display font-semibold min-w-0 truncate">Nuevo asiento</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>
      <div className="flex flex-wrap gap-3 mb-3">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="input w-40 min-w-0" />
        <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Concepto / descripción"
          className="input flex-1 min-w-0" />
      </div>

      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap gap-2 items-center">
            <select value={l.accountCode} onChange={(e) => setLine(i, { accountCode: e.target.value })}
              className="input flex-1 min-w-0">
              <option value="">— Cuenta —</option>
              {options.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </select>
            <input type="number" step="0.01" min="0" inputMode="decimal" value={l.debit} placeholder="Débito"
              onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })}
              className="input w-28 min-w-0 text-right tabular-nums" />
            <input type="number" step="0.01" min="0" inputMode="decimal" value={l.credit} placeholder="Crédito"
              onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })}
              className="input w-28 min-w-0 text-right tabular-nums" />
            <button type="button" onClick={() => setLines((arr) => arr.length > 2 ? arr.filter((_, idx) => idx !== i) : arr)}
              className="btn-icon text-ink-400 hover:text-rose-600 hover:bg-rose-50" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>

      <button type="button" onClick={() => setLines((arr) => [...arr, emptyLine()])}
        className="btn-ghost mt-2 -ml-2">
        <Plus size={14} /> Agregar línea
      </button>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mt-3 pt-3 border-t border-ink-100">
        <div className="text-sm tabular-nums text-ink-600 min-w-0">
          Débito <b>{formatDop(totDebit)}</b> · Crédito <b>{formatDop(totCredit)}</b>
          {imbalance !== 0 && <span className="ml-2 text-rose-600">Descuadre {formatDop(imbalance)}</span>}
        </div>
        <button type="button" onClick={save} disabled={saving || imbalance !== 0 || totDebit === 0}
          className="btn-primary self-start sm:self-auto">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar asiento
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}

export default function Ledger() {
  const { profileId, currentProfile } = useApp();
  const scope = profileId || 'team';
  const confirm = useConfirm();

  const [tab, setTab] = useState('diario'); // 'diario' | 'mayor' | 'balanza'
  const [showForm, setShowForm] = useState(false);
  const [mayorCode, setMayorCode] = useState('');
  const [reversing, setReversing] = useState(null);
  // Deep-link: /accounting/ledger?cuenta=<code> opens the Mayor for that account
  // (account drill-down from the Balanza and the financial statements).
  const [params] = useSearchParams();
  useEffect(() => {
    const c = params.get('cuenta');
    if (c) { setTab('mayor'); setMayorCode(c); }
    const t = params.get('tab');
    if (t === 'diario' || t === 'mayor' || t === 'balanza') setTab(t);
    if (params.get('new')) setShowForm(true);
  }, [params]);

  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const entriesQ = useLiveQueryStatus(() => db.journalEntries.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.journalLines.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded;

  const nameByCode = useMemo(() => {
    const m = new Map();
    for (const a of accountsQ.data) m.set(a.code, a.name);
    return m;
  }, [accountsQ.data]);

  const journal = useMemo(
    () => resolveJournal({ entries: entriesQ.data, lines: linesQ.data }),
    [entriesQ.data, linesQ.data],
  );
  const trial = useMemo(
    () => resolveTrialBalance({ accounts: accountsQ.data, lines: linesQ.data, entries: entriesQ.data }),
    [accountsQ.data, linesQ.data, entriesQ.data],
  );
  const mayor = useMemo(
    () => (mayorCode ? resolveAccountLedger({ accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data, accountCode: mayorCode }) : null),
    [mayorCode, accountsQ.data, entriesQ.data, linesQ.data],
  );
  // The chart-of-accounts tree with live roll-up balances — the navigator pane
  // of the Mayor master-detail (all-time, so a node's saldo matches its mayor).
  const chartTree = useMemo(
    () => resolveChartTree({ accounts: accountsQ.data, lines: linesQ.data, entries: entriesQ.data }),
    [accountsQ.data, linesQ.data, entriesQ.data],
  );
  const postable = useMemo(
    () => postableAccounts(accountsQ.data).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );

  // Column visibility (Shopify "edit columns") — one per desktop record-list
  // table, persisted per browser. Each table renders `cols` and feeds the menu
  // the full set so hidden columns can return.
  const mayorCols = useColumns(MAYOR_COLUMNS, MAYOR_DEFAULT, MAYOR_COLS_KEY);
  const balanzaCols = useColumns(BALANZA_COLUMNS, BALANZA_DEFAULT, BALANZA_COLS_KEY);
  // Drag-to-resize widths (persisted) for the same visible columns. Only the
  // header th get handles; the totals tfoot keys off `cols` unchanged.
  const {
    tableRef: mayorTableRef, tableStyle: mayorTableStyle, thProps: mayorThProps,
    ResizeHandle: MayorHandle, reset: resetMayorWidths,
  } = useColumnWidths(mayorCols.cols, 'rs.ledger.mayor.widths.v1');
  const {
    tableRef: balanzaTableRef, tableStyle: balanzaTableStyle, thProps: balanzaThProps,
    ResizeHandle: BalanzaHandle, reset: resetBalanzaWidths,
  } = useColumnWidths(balanzaCols.cols, 'rs.ledger.balanza.widths.v1');

  async function reverse(entry, lines) {
    const ok = await confirm({
      title: 'Reversar asiento',
      message: `Se creará un asiento espejo que anula el asiento #${entry.number ?? ''}. Queda registrado en el libro.`,
      confirmLabel: 'Reversar',
      tone: 'danger',
    });
    if (!ok) return;
    setReversing(entry.id);
    try {
      const built = buildReversalEntry({ newId, original: entry, originalLines: lines });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await db.journalEntries.update(entry.id, { reversedById: built.entry.id });
    } finally {
      setReversing(null);
    }
  }

  const isoDay = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');
  function exportActive() {
    if (tab === 'balanza') {
      downloadCsv('balanza.csv', [
        ['Cuenta', 'Nombre', 'Debito', 'Credito', 'Saldo'],
        ...trial.rows.map((r) => [r.code, r.name, r.debit, r.credit, r.balance]),
        ['', 'TOTALES', trial.totalDebit, trial.totalCredit, ''],
      ]);
    } else if (tab === 'mayor' && mayor) {
      downloadCsv(`mayor_${mayorCode}.csv`, [
        ['Fecha', 'Asiento', 'Concepto', 'Debito', 'Credito', 'Saldo'],
        ...mayor.rows.map(({ line, balance }) => [isoDay(line.postedAt), line.entryNumber ?? '', line.entryMemo || '', line.debit, line.credit, balance]),
      ]);
    } else if (tab === 'diario') {
      downloadCsv('diario.csv', [
        ['Asiento', 'Fecha', 'Origen', 'Cuenta', 'Nombre', 'Debito', 'Credito', 'Concepto'],
        ...journal.flatMap(({ entry, lines }) => lines.map((l) => [entry.number ?? '', isoDay(entry.postedAt), entry.source, l.accountCode, nameByCode.get(l.accountCode) || '', l.debit, l.credit, entry.memo || ''])),
      ]);
    }
  }

  return (
    <AccountingGate title="Libro contable">
      <PageHeader
        title="Libro contable"
        subtitle="Diario, mayor y balanza — partida doble en RD$"
        actions={
          <button type="button" onClick={() => { setShowForm((v) => !v); setTab('diario'); }}
            className="btn-primary">
            <Plus size={15} /> Nuevo asiento
          </button>
        }
      />

      <div className="flex flex-wrap items-start gap-2">
        <TabPills
          tabs={[{ key: 'diario', label: 'Diario' }, { key: 'mayor', label: 'Mayor' }, { key: 'balanza', label: 'Balanza' }]}
          active={tab} onChange={setTab} />
        <button type="button" onClick={exportActive}
          className="ml-auto btn-ghost"><Download size={14} /> <span className="hidden sm:inline">Exportar</span></button>
      </div>

      {showForm && accountsQ.loaded && (
        <NewEntryForm accounts={accountsQ.data} profileId={scope} userId={currentProfile?.id}
          onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : tab === 'diario' ? (
        journal.length === 0 ? (
          <EmptyState icon={BookOpen} title="Sin asientos"
            description="Registra el primer asiento con “Nuevo asiento”." />
        ) : (
          <div className="space-y-3">
            {journal.map(({ entry, lines, debit }) => (
              <div key={entry.id} className="card p-4">
                <div className="flex flex-wrap items-center gap-2 mb-2 min-w-0">
                  <span className="text-xs text-ink-400 tabular-nums whitespace-nowrap">#{entry.number ?? '—'}</span>
                  <span className="text-sm text-ink-500 whitespace-nowrap">{formatDate(entry.postedAt)}</span>
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-ink-100 text-ink-600 whitespace-nowrap">
                    {SOURCE_LABEL[entry.source] || entry.source}
                  </span>
                  {sourceDocHref(entry.refTable, entry.refId)
                    ? <Link to={sourceDocHref(entry.refTable, entry.refId)} className="text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline min-w-0 break-words">{entry.memo || '—'}</Link>
                    : <span className="text-sm font-medium text-ink-800 min-w-0 break-words">{entry.memo || '—'}</span>}
                  <span className="ml-auto text-sm font-semibold tabular-nums whitespace-nowrap">{formatDop(debit)}</span>
                  {entry.reversedById ? (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 whitespace-nowrap">Reversado</span>
                  ) : entry.reversesId ? (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 whitespace-nowrap">Reversión</span>
                  ) : (
                    <button type="button" onClick={() => reverse(entry, lines)} disabled={reversing === entry.id}
                      className="inline-flex items-center gap-1 rounded-md px-2 min-h-8 coarse:min-h-11 text-xs font-medium text-ink-500 hover:text-rose-700 hover:bg-rose-50 active:bg-rose-100 transition-colors disabled:opacity-40 whitespace-nowrap"
                      title="Reversar asiento — crea un asiento espejo">
                      {reversing === entry.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reversar
                    </button>
                  )}
                </div>
                <div className="overflow-x-auto -mx-4 px-4">
                <table className="w-full text-sm min-w-[280px]">
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id} className="border-t border-ink-50">
                        <td className="py-1 pr-2 min-w-0"><code className="text-[11px] text-ink-400 mr-2 tabular-nums">{l.accountCode}</code>{nameByCode.get(l.accountCode) || ''}</td>
                        <td className="py-1 px-2 text-right tabular-nums text-ink-700 w-28 whitespace-nowrap">{l.debit ? formatDop(l.debit) : ''}</td>
                        <td className="py-1 pl-2 text-right tabular-nums text-ink-700 w-28 whitespace-nowrap">{l.credit ? formatDop(l.credit) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            ))}
          </div>
        )
      ) : tab === 'mayor' ? (
        <div className="md:flex md:gap-4 md:items-start">
          {/* Desktop: interactive catálogo navigator with live roll-up saldos —
              click a postable account to open its mayor in the detail pane. */}
          <div className="hidden md:block md:w-80 lg:w-96 shrink-0">
            <AccountTree roots={chartTree.roots} selectedCode={mayorCode} onSelect={setMayorCode} />
          </div>
          {/* Mobile: the flat picker (the tree would crowd a phone). */}
          <select value={mayorCode} onChange={(e) => setMayorCode(e.target.value)}
            className="md:hidden mb-4 w-full max-w-lg rounded-lg border border-ink-200 px-3 py-2 text-sm">
            <option value="">— Elige una cuenta —</option>
            {postable.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
          <div className="flex-1 min-w-0">
          {!mayor ? (
            <EmptyState icon={BookOpen} title="Selecciona una cuenta"
              description="Elige una cuenta imputable para ver su mayor." />
          ) : mayor.rows.length === 0 ? (
            <EmptyState icon={BookOpen} title="Sin movimientos"
              description={`La cuenta ${mayor.account?.name || ''} no tiene movimientos.`} />
          ) : (
            <>
            <RowCards
              rows={mayor.rows.map(({ line, balance }) => ({
                key: line.id,
                title: line.entryMemo || '—',
                right: formatDop(balance),
                kv: [
                  ['Fecha', formatDate(line.postedAt)],
                  line.debit ? ['Débito', formatDop(line.debit)] : null,
                  line.credit ? ['Crédito', formatDop(line.credit)] : null,
                ],
              }))}
              footer={[
                ['Débito', formatDop(mayor.debit)],
                ['Crédito', formatDop(mayor.credit)],
                ['Saldo', formatDop(mayor.balance)],
              ]}
            />
            <div className="hidden md:block card overflow-hidden">
              <div className="flex justify-end px-3 pt-3">
                <ColumnsMenu columns={mayorCols.columns} visible={mayorCols.visible} onChange={mayorCols.setVisible} onReset={() => { mayorCols.reset(); resetMayorWidths(); }} />
              </div>
              <div className="overflow-x-auto">
              <table ref={mayorTableRef} style={mayorTableStyle} className="w-full text-sm min-w-[420px]">
                <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                  <tr>
                    {mayorCols.cols.map((col) => (
                      <th key={col.key} className={col.thClass || ''} {...mayorThProps(col.key)}>{col.label}{MayorHandle(col.key)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mayor.rows.map(({ line, balance }) => {
                    const ctx = { line, balance };
                    return (
                      <tr key={line.id} className="border-t border-ink-50">
                        {mayorCols.cols.map((col) => (
                          <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-200 font-semibold">
                    {mayorCols.cols.map((col) => {
                      if (col.key === 'fecha') return <td key={col.key} className="py-2 px-3">Totales</td>;
                      if (col.key === 'debito') return <td key={col.key} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(mayor.debit)}</td>;
                      if (col.key === 'credito') return <td key={col.key} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(mayor.credit)}</td>;
                      if (col.key === 'saldo') return <td key={col.key} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(mayor.balance)}</td>;
                      return <td key={col.key} className="py-2 px-3" />;
                    })}
                  </tr>
                </tfoot>
              </table>
              </div>
            </div>
            </>
          )}
          </div>
        </div>
      ) : (
        trial.rows.length === 0 ? (
          <EmptyState icon={BookOpen} title="Sin movimientos"
            description="No hay asientos que mostrar en la balanza." />
        ) : (
          <>
          <RowCards
            rows={trial.rows.map((r) => ({
              key: r.code,
              title: <><code className="text-[11px] text-ink-400 mr-2 tabular-nums">{r.code}</code>{r.name}</>,
              right: formatDop(r.balance),
              onClick: () => { setTab('mayor'); setMayorCode(r.code); },
              kv: [
                ['Débito', formatDop(r.debit)],
                ['Crédito', formatDop(r.credit)],
              ],
            }))}
            footer={[
              ['Totales', trial.balanced ? '✓ cuadrado' : 'descuadrado'],
              ['Débito', formatDop(trial.totalDebit)],
              ['Crédito', formatDop(trial.totalCredit)],
            ]}
          />
          <div className="hidden md:block card overflow-hidden">
            <div className="flex justify-end px-3 pt-3">
              <ColumnsMenu columns={balanzaCols.columns} visible={balanzaCols.visible} onChange={balanzaCols.setVisible} onReset={() => { balanzaCols.reset(); resetBalanzaWidths(); }} />
            </div>
            <div className="overflow-x-auto">
            <table ref={balanzaTableRef} style={balanzaTableStyle} className="w-full text-sm min-w-[360px]">
              <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                <tr>
                  {balanzaCols.cols.map((col) => (
                    <th key={col.key} className={col.thClass || ''} {...balanzaThProps(col.key)}>{col.label}{BalanzaHandle(col.key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trial.rows.map((r) => {
                  const ctx = { r };
                  return (
                    <tr key={r.code} onClick={() => { setTab('mayor'); setMayorCode(r.code); }}
                      className="border-t border-ink-50 cursor-pointer hover:bg-ink-50" title="Ver mayor">
                      {balanzaCols.cols.map((col) => (
                        <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-200 font-semibold">
                  {balanzaCols.cols.map((col) => {
                    if (col.key === 'cuenta') return (
                      <td key={col.key} className="py-2 px-3 whitespace-nowrap">Totales {trial.balanced
                        ? <span className="ml-2 text-xs text-emerald-700">✓ cuadrado</span>
                        : <span className="ml-2 text-xs text-rose-600">descuadrado</span>}</td>
                    );
                    if (col.key === 'debito') return <td key={col.key} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(trial.totalDebit)}</td>;
                    if (col.key === 'credito') return <td key={col.key} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(trial.totalCredit)}</td>;
                    return <td key={col.key} className="py-2 px-3" />;
                  })}
                </tr>
              </tfoot>
            </table>
            </div>
          </div>
          </>
        )
      )}
    </AccountingGate>
  );
}
