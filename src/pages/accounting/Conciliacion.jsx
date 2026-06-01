import { useMemo, useState } from 'react';
import { Shield, Landmark, Check } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveReconciliation } from '../../core/accounting/index.js';

/**
 * Conciliación bancaria — pick a bank account, tick the ledger lines that
 * cleared the bank statement, and compare the reconciled balance to the
 * statement's ending balance. Self-gates on accounting/admin.
 */
export default function Conciliacion() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const entriesQ = useLiveQueryStatus(() => db.journalEntries.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.journalLines.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = accountsQ.loaded && entriesQ.loaded && linesQ.loaded;

  // Bank/cash accounts = postable leaves under Cajas y Bancos (1-01-001).
  const bankAccounts = useMemo(
    () => accountsQ.data.filter((a) => a.isPostable && a.code.startsWith('1-01-001')).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );
  const [accountCode, setAccountCode] = useState('');
  const [stmt, setStmt] = useState('');
  const [busy, setBusy] = useState(null);

  const rec = useMemo(
    () => (accountCode ? resolveReconciliation({ accounts: accountsQ.data, entries: entriesQ.data, lines: linesQ.data, accountCode, statementBalance: stmt }) : null),
    [accountCode, accountsQ.data, entriesQ.data, linesQ.data, stmt],
  );

  if (!allowed) {
    return (
      <>
        <PageHeader title="Conciliación bancaria" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  async function toggle(row) {
    setBusy(row.line.id);
    try {
      await db.journalLines.update(row.line.id, { reconciledAt: row.reconciled ? null : Date.now() });
    } finally {
      setBusy(null);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-3 py-1.5 text-sm';

  return (
    <>
      <PageHeader title="Conciliación bancaria" subtitle="Marca los movimientos que aparecen en el estado del banco" />

      {!loaded ? <ListLoading /> : (
        <>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <label className="text-sm">Cuenta bancaria<br />
              <select value={accountCode} onChange={(e) => setAccountCode(e.target.value)} className={`${field} min-w-[280px]`}>
                <option value="">— Elige una cuenta —</option>
                {bankAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
              </select>
            </label>
            <label className="text-sm">Saldo del estado<br />
              <input type="number" step="0.01" value={stmt} onChange={(e) => setStmt(e.target.value)} placeholder="Saldo final banco" className={`${field} w-40 text-right tabular-nums`} />
            </label>
          </div>

          {!rec ? (
            <EmptyState icon={Landmark} title="Selecciona una cuenta" description="Elige una cuenta bancaria para conciliar." />
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="card p-3"><div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Saldo en libros</div><div className="text-lg font-semibold tabular-nums">{formatDop(rec.ledgerBalance)}</div></div>
                <div className="card p-3"><div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Conciliado</div><div className="text-lg font-semibold tabular-nums">{formatDop(rec.reconciledBalance)}</div></div>
                <div className="card p-3"><div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Pendiente</div><div className="text-lg font-semibold tabular-nums">{formatDop(rec.pendingBalance)}</div></div>
                <div className="card p-3"><div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Diferencia vs. estado</div>
                  <div className={`text-lg font-semibold tabular-nums ${rec.difference === 0 ? 'text-emerald-700' : rec.difference == null ? 'text-ink-400' : 'text-rose-700'}`}>
                    {rec.difference == null ? '—' : formatDop(rec.difference)}
                  </div>
                </div>
              </div>

              {rec.count === 0 ? (
                <EmptyState icon={Landmark} title="Sin movimientos" description="Esta cuenta no tiene movimientos en el mayor." />
              ) : (
                <div className="card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                      <tr>
                        <th className="text-left py-2 px-3 w-10"></th>
                        <th className="text-left py-2 px-3">Fecha</th>
                        <th className="text-left py-2 px-3">#</th>
                        <th className="text-left py-2 px-3">Concepto</th>
                        <th className="text-right py-2 px-3">Monto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rec.rows.map((row) => (
                        <tr key={row.line.id} className={`border-t border-ink-50 ${row.reconciled ? 'bg-emerald-50/40' : ''}`}>
                          <td className="py-1.5 px-3">
                            <button type="button" onClick={() => toggle(row)} disabled={busy === row.line.id}
                              className={`w-5 h-5 rounded border inline-flex items-center justify-center ${row.reconciled ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-ink-300 text-transparent hover:border-ink-500'}`}
                              title={row.reconciled ? 'Quitar conciliación' : 'Marcar conciliado'}>
                              <Check size={13} />
                            </button>
                          </td>
                          <td className="py-1.5 px-3 text-ink-500">{formatDate(row.postedAt)}</td>
                          <td className="py-1.5 px-3 tabular-nums text-ink-400">{row.number ?? '—'}</td>
                          <td className="py-1.5 px-3">{row.memo || '—'}</td>
                          <td className={`py-1.5 px-3 text-right tabular-nums ${row.amount < 0 ? 'text-rose-700' : ''}`}>{formatDop(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
