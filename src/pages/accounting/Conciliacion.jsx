import { useEffect, useMemo, useState } from 'react';
import { Landmark, Check, Upload, X, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import FileDropZone from '../../components/FileDropZone.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { resolveReconciliation, resolveBankImport, buildJournalEntry, round2 } from '../../core/accounting/index.js';

// Reconciliation table columns (Shopify "edit columns"). The reconcile
// checkbox is a fixed leading cell (closes over the toggle handler), outside
// this array; fecha is the identity anchor; #, concepto and monto toggle.
const RECON_COLUMNS = [
  {
    key: 'date', label: 'Fecha', canHide: false,
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ row }) => formatDate(row.postedAt),
  },
  {
    key: 'number', label: '#',
    tdClass: 'tabular-nums text-ink-400 whitespace-nowrap',
    cell: ({ row }) => row.number ?? '—',
  },
  {
    key: 'memo', label: 'Concepto',
    tdClass: 'min-w-[120px]',
    cell: ({ row }) => row.memo || '—',
  },
  {
    key: 'amount', label: 'Monto',
    thClass: 'text-right whitespace-nowrap',
    cell: ({ row }) => <span className={`block text-right tabular-nums whitespace-nowrap ${row.amount < 0 ? 'text-rose-700' : ''}`}>{formatDop(row.amount)}</span>,
  },
];
const RECON_DEFAULT = { number: true, memo: true, amount: true };

/**
 * Conciliación bancaria — pick a bank account, then either tick the ledger
 * lines that cleared the statement by hand, or IMPORT the bank's exported
 * movements (Banco Popular first): each line auto-matches an existing asiento
 * (Match, never duplicate) and the leftover (comisiones, intereses…) posts via
 * a categorization rule. Self-gates on accounting/admin via AccountingGate.
 */
export default function Conciliacion() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const entriesQ = useLiveQueryStatus(() => db.journalEntries.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.journalLines.where('profileId').equals(scope).toArray(), [scope], []);
  const rulesQ = useLiveQueryStatus(() => db.bankRules.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded && rulesQ.loaded;

  // Bank/cash accounts = postable leaves under Cajas y Bancos (1-01-001).
  const bankAccounts = useMemo(
    () => accountsQ.data.filter((a) => a.isPostable && a.code.startsWith('1-01-001')).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );
  const [accountCode, setAccountCode] = useState('');
  const [stmt, setStmt] = useState('');
  const [busy, setBusy] = useState(null);
  const [importing, setImporting] = useState(false);

  const recCols = useColumns(RECON_COLUMNS, RECON_DEFAULT, 'rs.conciliacion.cols.v1');
  const recW = useColumnWidths(recCols.cols, 'rs.conciliacion.widths.v1');

  const rec = useMemo(
    () => (accountCode ? resolveReconciliation({ accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data, accountCode, statementBalance: stmt }) : null),
    [accountCode, accountsQ.data, entriesQ.data, linesQ.data, stmt],
  );

  async function toggle(row) {
    setBusy(row.line.id);
    try {
      await db.journalLines.update(row.line.id, { reconciledAt: row.reconciled ? null : Date.now() });
    } finally {
      setBusy(null);
    }
  }

  const field = 'input';

  return (
    <AccountingGate title="Conciliación bancaria">
      <PageHeader title="Conciliación bancaria" subtitle="Marca los movimientos del estado del banco — o importa el estado de cuenta"
        actions={<button type="button" disabled={!accountCode} onClick={() => setImporting((v) => !v)} className="btn-ghost disabled:opacity-40"><Upload size={14} /> Importar estado</button>} />

      {!loaded ? <ListLoading /> : (
        <>
          <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-end gap-3 mb-4">
            <label className="text-sm">Cuenta bancaria<br />
              <select value={accountCode} onChange={(e) => { setAccountCode(e.target.value); setImporting(false); }} className={`${field} w-full sm:min-w-[240px]`}>
                <option value="">— Elige una cuenta —</option>
                {bankAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
              </select>
            </label>
            <label className="text-sm">Saldo del estado<br />
              <input type="number" step="0.01" inputMode="decimal" enterKeyHint="done" value={stmt} onChange={(e) => setStmt(e.target.value)} placeholder="Saldo final banco" className={`${field} w-full sm:w-40 text-right tabular-nums`} />
            </label>
          </div>

          {!rec ? (
            <EmptyState icon={Landmark} title="Selecciona una cuenta" description="Elige una cuenta bancaria para conciliar." />
          ) : (
            <>
              {importing && (
                <BankImportPanel scope={scope} accountCode={accountCode} rec={rec} rules={rulesQ.data} accounts={accountsQ.data} onClose={() => setImporting(false)} />
              )}

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="card p-3 min-w-0"><div className="eyebrow mb-1">Saldo en libros</div><div className="font-display text-base sm:text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(rec.ledgerBalance)}</div></div>
                <div className="card p-3 min-w-0"><div className="eyebrow mb-1">Conciliado</div><div className="font-display text-base sm:text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(rec.reconciledBalance)}</div></div>
                <div className="card p-3 min-w-0"><div className="eyebrow mb-1">Pendiente</div><div className="font-display text-base sm:text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(rec.pendingBalance)}</div></div>
                <div className="card p-3 min-w-0"><div className="eyebrow mb-1">Diferencia vs. estado</div>
                  <div className={`font-display text-base sm:text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto ${rec.difference === 0 ? 'text-emerald-700' : rec.difference == null ? 'text-ink-400' : 'text-rose-700'}`}>
                    {rec.difference == null ? '—' : formatDop(rec.difference)}
                  </div>
                </div>
              </div>

              {rec.count === 0 ? (
                <EmptyState icon={Landmark} title="Sin movimientos" description="Esta cuenta no tiene movimientos en el mayor." />
              ) : (
                <>
                <div className="hidden md:flex justify-end mb-2">
                  <ColumnsMenu columns={recCols.columns} visible={recCols.visible} onChange={recCols.setVisible} onReset={() => { recCols.reset(); recW.reset(); }} />
                </div>
                <div className="card overflow-hidden">
                  <div className="overflow-x-auto">
                    <table ref={recW.tableRef} style={recW.tableStyle} className="table min-w-[480px]">
                      <thead>
                        <tr>
                          <th className="w-10"></th>
                          {recCols.cols.map((col) => (
                            <th key={col.key} className={col.thClass || ''} {...recW.thProps(col.key)}>{col.label}{recW.ResizeHandle(col.key)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rec.rows.map((row) => {
                          const ctx = { row };
                          return (
                            <tr key={row.line.id} className={row.reconciled ? 'bg-emerald-50/40' : ''}>
                              <td>
                                <button type="button" onClick={() => toggle(row)} disabled={busy === row.line.id}
                                  className={`w-6 h-6 coarse:w-11 coarse:h-11 rounded border inline-flex items-center justify-center transition-colors coarse:rounded-lg ${row.reconciled ? 'bg-emerald-600 border-emerald-600 text-white active:bg-emerald-700' : 'border-ink-300 text-transparent hover:border-ink-500 active:bg-ink-100'}`}
                                  title={row.reconciled ? 'Quitar conciliación' : 'Marcar conciliado'}
                                  aria-label={row.reconciled ? 'Quitar conciliación' : 'Marcar conciliado'}
                                  aria-pressed={row.reconciled}>
                                  <Check size={13} />
                                </button>
                              </td>
                              {recCols.cols.map((col) => (
                                <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </AccountingGate>
  );
}

/** Post a bank-only movement (comisión, interés…) the statement carried but the
 *  books didn't: Debit/Credit the bank account by the signed amount against the
 *  chosen contra account, and mark the bank line reconciled (it cleared). */
async function postBankLine({ scope, accountCode, contraCode, sl }) {
  const abs = round2(Math.abs(sl.amount));
  const lines = sl.amount >= 0
    ? [{ accountCode, debit: abs }, { accountCode: contraCode, credit: abs }]
    : [{ accountCode: contraCode, debit: abs }, { accountCode, credit: abs }];
  const built = buildJournalEntry({ newId, profileId: scope, postedAt: sl.date, memo: sl.description || 'Movimiento bancario', source: 'manual', refTable: 'bank_statement', lines });
  const now = Date.now();
  const withRec = built.lines.map((l) => (l.accountCode === accountCode ? { ...l, reconciledAt: now } : l));
  await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
  await db.journalLines.bulkPut(withRec);
}

const STATUS_BADGE = {
  matched: { cls: 'bg-emerald-100 text-emerald-700', label: 'Emparejado' },
  suggested: { cls: 'bg-sky-100 text-sky-700', label: 'Sugerido' },
  unmatched: { cls: 'bg-amber-100 text-amber-700', label: 'Sin match' },
};

function BankImportPanel({ scope, accountCode, rec, rules, accounts, onClose }) {
  const [bank, setBank] = useState('popular');
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState({}); // index -> { post, account, remember }
  const [fileName, setFileName] = useState('');
  const [pasteMode, setPasteMode] = useState(false);

  const imp = useMemo(
    () => (text.trim() ? resolveBankImport({ statementText: text, bank, rules, reconciliation: rec }) : null),
    [text, bank, rules, rec],
  );

  useEffect(() => {
    if (!imp) { setSel({}); return; }
    const next = {};
    imp.items.forEach((it, i) => {
      next[i] = it.status === 'matched'
        ? { post: true, account: '', remember: false }
        : { post: false, account: it.rule?.accountCode || '', remember: false };
    });
    setSel(next);
  }, [imp]); // eslint-disable-line react-hooks/exhaustive-deps

  const contraAccounts = useMemo(
    () => (accounts || []).filter((a) => a.isPostable && [4, 5, 6].includes(a.class)).sort((a, b) => a.code.localeCompare(b.code)),
    [accounts],
  );

  const willApply = imp ? imp.items.filter((it, i) => sel[i]?.post && (it.status === 'matched' || sel[i]?.account)).length : 0;

  async function apply() {
    if (!imp) return;
    setErr(''); setPosting(true);
    try {
      const now = Date.now();
      for (let i = 0; i < imp.items.length; i++) {
        const it = imp.items[i]; const s = sel[i] || {};
        if (!s.post) continue;
        if (it.status === 'matched' && it.ledgerRow?.line?.id) {
          await db.journalLines.update(it.ledgerRow.line.id, { reconciledAt: now });
        } else if (it.status !== 'matched' && s.account) {
          await postBankLine({ scope, accountCode, contraCode: s.account, sl: it.statementLine });
          if (s.remember && it.statementLine.description) {
            await db.bankRules.put({
              id: newId(), profileId: scope, bank, bankAccountCode: accountCode,
              matchType: 'contains', pattern: it.statementLine.description, accountCode: s.account,
              label: '', priority: 0, autoConfirm: false, createdAt: now, updatedAt: now,
            });
          }
        }
      }
      onClose();
    } catch (e) { setErr(userMessageFor(e)); setPosting(false); }
  }

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-semibold">Importar estado de cuenta</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>

      <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-end gap-3 mb-3">
        <label className="text-sm">Banco<br />
          <select value={bank} onChange={(e) => setBank(e.target.value)} className="input w-full sm:w-48">
            {(imp?.banks || [{ key: 'popular', label: 'Banco Popular' }, { key: 'generic', label: 'Genérico' }]).map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
        </label>
      </div>
      {pasteMode ? (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5}
            placeholder={'Pega el CSV exportado de Popular en Línea (Fecha, Descripción, Débito, Crédito, Balance)…'}
            className="input w-full font-mono text-xs" autoFocus />
          <button type="button" onClick={() => setPasteMode(false)} className="mt-1.5 text-xs text-ink-500 hover:text-ink-900">← subir un archivo .csv</button>
        </>
      ) : (
        <>
          <FileDropZone
            mode="text"
            accept=".csv,.txt,text/csv,text/plain,application/vnd.ms-excel"
            hint="Arrastra el .csv exportado de tu banco (Fecha · Descripción · Débito · Crédito · Balance)"
            fileName={fileName}
            onClear={() => { setFileName(''); setText(''); }}
            onText={(t, f) => { setText(t); setFileName(f?.name || 'estado.csv'); }}
          />
          {!fileName && (
            <button type="button" onClick={() => setPasteMode(true)} className="mt-1.5 text-xs text-ink-500 hover:text-ink-900">o pegar el texto manualmente</button>
          )}
        </>
      )}

      {imp && (
        <>
          <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
            <Chip cls={STATUS_BADGE.matched.cls}>{imp.summary.matched} emparejados</Chip>
            <Chip cls={STATUS_BADGE.suggested.cls}>{imp.summary.suggested} sugeridos</Chip>
            <Chip cls={STATUS_BADGE.unmatched.cls}>{imp.summary.unmatched} sin match</Chip>
            {imp.parsed.skipped > 0 && <span className="text-ink-400">{imp.parsed.skipped} filas omitidas</span>}
            {imp.parsed.lines.length === 0 && <span className="text-rose-600">No se reconoció ninguna fila — revisa el formato.</span>}
          </div>

          <div className="mt-3 space-y-2">
            {imp.items.map((it, i) => {
              const s = sel[i] || {};
              const badge = STATUS_BADGE[it.status];
              return (
                <div key={i} className="border border-ink-100 rounded-lg p-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-ink-500 text-xs whitespace-nowrap tabular-nums">{formatDate(it.statementLine.date)}</span>
                  <span className="flex-1 min-w-[140px] text-sm truncate" title={it.statementLine.description}>{it.statementLine.description || '—'}</span>
                  <span className={`text-sm tabular-nums whitespace-nowrap ${it.statementLine.amount < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{formatDop(it.statementLine.amount)}</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
                  {it.status === 'matched' ? (
                    <span className="text-xs text-ink-500 whitespace-nowrap">↔ #{it.ledgerRow.number ?? '—'} {it.ledgerRow.memo || ''}</span>
                  ) : (
                    <select value={s.account || ''} onChange={(e) => setSel((m) => ({ ...m, [i]: { ...m[i], account: e.target.value } }))} className="input text-xs py-1 w-full sm:w-56">
                      <option value="">— cuenta contrapartida —</option>
                      {contraAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                    </select>
                  )}
                  <label className="text-xs text-ink-600 inline-flex items-center gap-1 whitespace-nowrap">
                    <input type="checkbox" checked={!!s.post} onChange={(e) => setSel((m) => ({ ...m, [i]: { ...m[i], post: e.target.checked } }))} />
                    {it.status === 'matched' ? 'Conciliar' : 'Registrar'}
                  </label>
                  {it.status !== 'matched' && (
                    <label className="text-xs text-ink-400 inline-flex items-center gap-1 whitespace-nowrap" title="Guardar una regla para la próxima vez">
                      <input type="checkbox" checked={!!s.remember} onChange={(e) => setSel((m) => ({ ...m, [i]: { ...m[i], remember: e.target.checked } }))} /> regla
                    </label>
                  )}
                </div>
              );
            })}
          </div>

          {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button type="button" onClick={onClose} className="btn-ghost">Cancelar</button>
            <button type="button" onClick={apply} disabled={posting || willApply === 0} className="btn-primary">
              {posting ? <Loader2 size={14} className="animate-spin" /> : null} Aplicar {willApply > 0 ? `(${willApply})` : ''}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Chip({ cls, children }) {
  return <span className={`px-1.5 py-0.5 rounded ${cls}`}>{children}</span>;
}
