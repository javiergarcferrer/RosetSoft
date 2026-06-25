import { useMemo, useState } from 'react';
import { ScrollText, Plus, Minus, Pencil } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDate } from '../../lib/format.js';
import { resolveAuditTrail } from '../../core/accounting/index.js';

const ACTION_ICON = { insert: Plus, update: Pencil, delete: Minus };
const ACTION_CLS = { insert: 'text-emerald-600', update: 'text-sky-600', delete: 'text-rose-600' };

/**
 * Bitácora — the append-only audit trail of every change to the financial
 * tables (written by a Postgres trigger; read-only here). Supports DGII
 * inalterability: nothing is edited in place, and every change is recorded.
 * Self-gates on accounting/admin.
 */
export default function Bitacora() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const logQ = useLiveQueryStatus(() => db.auditLog.orderBy('loggedAt').reverse().limit(800).toArray(), [scope], []);
  const profilesQ = useLiveQueryStatus(() => db.profiles.toArray(), [], []);
  const loaded = logQ.loaded && profilesQ.loaded;
  const profilesById = useMemo(() => new Map(profilesQ.data.map((p) => [p.id, p])), [profilesQ.data]);

  const [q, setQ] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  const trail = useMemo(
    () => resolveAuditTrail({ rows: logQ.data, profilesById, query: q, tableFilter, actionFilter }),
    [logQ.data, profilesById, q, tableFilter, actionFilter],
  );

  return (
    <AccountingGate title="Bitácora">
      <PageHeader title="Bitácora" subtitle="Registro inalterable de cambios en los libros — solo lectura" />

      {!loaded ? <ListLoading /> : (
        <>
          <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-end gap-3 mb-4">
            <label className="text-sm">Buscar<br /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="usuario, campo, id…" className="input w-full sm:w-56" /></label>
            <label className="text-sm">Tabla<br />
              <select value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} className="input w-full sm:w-44">
                <option value="">Todas</option>
                {trail.tables.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="text-sm">Acción<br />
              <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="input w-full sm:w-36">
                <option value="">Todas</option><option value="insert">Creó</option><option value="update">Modificó</option><option value="delete">Eliminó</option>
              </select>
            </label>
          </div>

          {trail.count === 0 ? (
            <EmptyState icon={ScrollText} title="Sin registros" description="Los cambios en facturas, gastos, pagos y asientos aparecerán aquí." />
          ) : (
            <div className="card overflow-hidden divide-y divide-ink-100">
              {trail.rows.map((e) => {
                const Icon = ACTION_ICON[e.action] || Pencil;
                return (
                  <div key={e.id} className="px-3 py-2 flex items-center gap-3">
                    <Icon size={15} className={`shrink-0 ${ACTION_CLS[e.action] || 'text-ink-500'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm"><b>{e.userName}</b> {e.actionLabel.toLowerCase()} {e.tableLabel} <code className="text-[11px] text-ink-400">{e.rowId}</code></div>
                      {e.action === 'update' && <div className="text-xs text-ink-500 truncate">{e.summary}</div>}
                    </div>
                    <span className="text-xs text-ink-400 whitespace-nowrap shrink-0">{formatDate(e.loggedAt)}</span>
                  </div>
                );
              })}
              {trail.count > trail.rows.length && <p className="text-xs text-ink-400 text-center py-2 bg-ink-50/40">Mostrando {trail.rows.length} de {trail.count}.</p>}
            </div>
          )}
        </>
      )}
    </AccountingGate>
  );
}
