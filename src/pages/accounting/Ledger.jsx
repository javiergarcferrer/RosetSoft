import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, BookOpen, Plus, Trash2, Loader2, Check, X, RotateCcw, Download } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import { downloadCsv } from '../../lib/csv.js';
import {
  resolveJournal, resolveTrialBalance, resolveAccountLedger,
  postableAccounts, assertBalanced, buildJournalEntry, buildReversalEntry, debitTotal, creditTotal,
} from '../../core/accounting/index.js';

/**
 * Libro contable — the general-ledger surface:
 *   • Diario  — every asiento newest-first, plus a "Nuevo asiento" form that
 *               posts a balanced manual entry (the app refuses to save an
 *               unbalanced one, via assertBalanced).
 *   • Mayor   — one account's movements with a running balance.
 *   • Balanza — the trial balance (Σ débito must equal Σ crédito).
 * Self-gates on the accounting/admin role.
 */
const SOURCE_LABEL = {
  manual: 'Manual', opening: 'Apertura', sale: 'Venta', purchase: 'Compra',
  expense: 'Gasto', payment: 'Pago', import: 'Importación', payroll: 'Nómina',
  depreciation: 'Depreciación', fx: 'Cambio', tax: 'Impuestos', gateway: 'Pasarela',
  adjustment: 'Ajuste',
};

function emptyLine() { return { accountCode: '', debit: '', credit: '' }; }

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
      setErr(e?.message || String(e));
      setSaving(false);
    }
  }

  return (
    <div className="card p-4 mb-4 border-ink-300">
      <div className="flex items-center justify-between mb-3 gap-2 min-w-0">
        <h3 className="font-semibold min-w-0 truncate">Nuevo asiento</h3>
        <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-700 shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center"><X size={18} /></button>
      </div>
      <div className="flex flex-wrap gap-3 mb-3">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm" />
        <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Concepto / descripción"
          className="flex-1 min-w-[180px] rounded-lg border border-ink-200 px-3 py-1.5 text-sm" />
      </div>

      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap gap-2 items-center">
            <select value={l.accountCode} onChange={(e) => setLine(i, { accountCode: e.target.value })}
              className="flex-1 min-w-[180px] rounded-lg border border-ink-200 px-2 py-1.5 text-sm">
              <option value="">— Cuenta —</option>
              {options.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </select>
            <input type="number" step="0.01" min="0" value={l.debit} placeholder="Débito"
              onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })}
              className="w-28 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums" />
            <input type="number" step="0.01" min="0" value={l.credit} placeholder="Crédito"
              onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })}
              className="w-28 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums" />
            <button type="button" onClick={() => setLines((arr) => arr.length > 2 ? arr.filter((_, idx) => idx !== i) : arr)}
              className="text-ink-400 hover:text-rose-600 min-h-[44px] min-w-[44px] flex items-center justify-center" title="Eliminar línea"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>

      <button type="button" onClick={() => setLines((arr) => [...arr, emptyLine()])}
        className="mt-2 text-sm text-ink-600 inline-flex items-center gap-1 hover:text-ink-900 min-h-[44px] px-1">
        <Plus size={14} /> Agregar línea
      </button>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mt-3 pt-3 border-t border-ink-100">
        <div className="text-sm tabular-nums text-ink-600 min-w-0">
          Débito <b>{formatDop(totDebit)}</b> · Crédito <b>{formatDop(totCredit)}</b>
          {imbalance !== 0 && <span className="ml-2 text-rose-600">Descuadre {formatDop(imbalance)}</span>}
        </div>
        <button type="button" onClick={save} disabled={saving || imbalance !== 0 || totDebit === 0}
          className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40 self-start sm:self-auto min-h-[44px] px-4">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar asiento
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}

export default function Ledger() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

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
  const postable = useMemo(
    () => postableAccounts(accountsQ.data).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );

  async function reverse(entry, lines) {
    if (typeof window !== 'undefined'
      && !window.confirm(`¿Reversar el asiento #${entry.number ?? ''}? Se creará un asiento espejo.`)) return;
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

  if (!allowed) {
    return (
      <>
        <PageHeader title="Libro contable" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const tabBtn = (key, label) => (
    <button type="button" onClick={() => setTab(key)}
      className={`text-sm px-3 py-2 rounded-lg min-h-[44px] ${tab === key ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>
      {label}
    </button>
  );

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
    <>
      <PageHeader
        title="Libro contable"
        subtitle="Diario, mayor y balanza — partida doble en RD$"
        actions={
          <button type="button" onClick={() => { setShowForm((v) => !v); setTab('diario'); }}
            className="btn-primary text-sm inline-flex items-center gap-1.5">
            <Plus size={15} /> Nuevo asiento
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {tabBtn('diario', 'Diario')}
        {tabBtn('mayor', 'Mayor')}
        {tabBtn('balanza', 'Balanza')}
        <button type="button" onClick={exportActive}
          className="ml-auto btn-ghost text-sm inline-flex items-center gap-1.5 min-h-[44px] px-3"><Download size={14} /> <span className="hidden sm:inline">Exportar</span></button>
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
                  <span className="text-sm font-medium text-ink-800 min-w-0 break-words">{entry.memo || '—'}</span>
                  <span className="ml-auto text-sm font-semibold tabular-nums whitespace-nowrap">{formatDop(debit)}</span>
                  {entry.reversedById ? (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 whitespace-nowrap">Reversado</span>
                  ) : entry.reversesId ? (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 whitespace-nowrap">Reversión</span>
                  ) : (
                    <button type="button" onClick={() => reverse(entry, lines)} disabled={reversing === entry.id}
                      className="text-ink-400 hover:text-rose-600 disabled:opacity-40 min-h-[44px] min-w-[44px] flex items-center justify-center" title="Reversar asiento">
                      {reversing === entry.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
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
        <>
          <select value={mayorCode} onChange={(e) => setMayorCode(e.target.value)}
            className="mb-4 w-full max-w-lg rounded-lg border border-ink-200 px-3 py-2 text-sm">
            <option value="">— Elige una cuenta —</option>
            {postable.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
          {!mayor ? (
            <EmptyState icon={BookOpen} title="Selecciona una cuenta"
              description="Elige una cuenta imputable para ver su mayor." />
          ) : mayor.rows.length === 0 ? (
            <EmptyState icon={BookOpen} title="Sin movimientos"
              description={`La cuenta ${mayor.account?.name || ''} no tiene movimientos.`} />
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[420px]">
                <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left py-2 px-3 whitespace-nowrap">Fecha</th>
                    <th className="text-left py-2 px-3">Concepto</th>
                    <th className="text-right py-2 px-3 whitespace-nowrap">Débito</th>
                    <th className="text-right py-2 px-3 whitespace-nowrap">Crédito</th>
                    <th className="text-right py-2 px-3 whitespace-nowrap">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {mayor.rows.map(({ line, balance }) => (
                    <tr key={line.id} className="border-t border-ink-50">
                      <td className="py-1.5 px-3 text-ink-500 whitespace-nowrap">{formatDate(line.postedAt)}</td>
                      <td className="py-1.5 px-3 min-w-0">{line.entryMemo || '—'}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{line.debit ? formatDop(line.debit) : ''}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{line.credit ? formatDop(line.credit) : ''}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium whitespace-nowrap">{formatDop(balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-200 font-semibold">
                    <td className="py-2 px-3" colSpan={2}>Totales</td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(mayor.debit)}</td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(mayor.credit)}</td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(mayor.balance)}</td>
                  </tr>
                </tfoot>
              </table>
              </div>
            </div>
          )}
        </>
      ) : (
        trial.rows.length === 0 ? (
          <EmptyState icon={BookOpen} title="Sin movimientos"
            description="No hay asientos que mostrar en la balanza." />
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[360px]">
              <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left py-2 px-3">Cuenta</th>
                  <th className="text-right py-2 px-3 whitespace-nowrap">Débito</th>
                  <th className="text-right py-2 px-3 whitespace-nowrap">Crédito</th>
                  <th className="text-right py-2 px-3 whitespace-nowrap">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {trial.rows.map((r) => (
                  <tr key={r.code} onClick={() => { setTab('mayor'); setMayorCode(r.code); }}
                    className="border-t border-ink-50 cursor-pointer hover:bg-ink-50" title="Ver mayor">
                    <td className="py-1.5 px-3 min-w-0"><code className="text-[11px] text-ink-400 mr-2 tabular-nums">{r.code}</code>{r.name}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(r.debit)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(r.credit)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium whitespace-nowrap">{formatDop(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-200 font-semibold">
                  <td className="py-2 px-3 whitespace-nowrap">Totales {trial.balanced
                    ? <span className="ml-2 text-xs text-emerald-700">✓ cuadrado</span>
                    : <span className="ml-2 text-xs text-rose-600">descuadrado</span>}</td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(trial.totalDebit)}</td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(trial.totalCredit)}</td>
                  <td className="py-2 px-3"></td>
                </tr>
              </tfoot>
            </table>
            </div>
          </div>
        )
      )}
    </>
  );
}
