import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, Trash2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { useConfirm } from '../../components/ConfirmProvider.jsx';
import { formatDate } from '../../lib/format.js';

const ROUTE_LABEL = {
  '/accounting/statements': 'Estados financieros', '/accounting/informes': 'Informes',
  '/accounting/impuestos': 'DGII 606/607', '/accounting/flujo-proyectado': 'Flujo proyectado',
  '/accounting/presupuesto': 'Presupuesto', '/accounting/ledger': 'Libro mayor', '/accounting/dashboard': 'Resumen',
};

/** Vistas guardadas — memorized report shortcuts. Self-gates on accounting/admin. */
export default function SavedReports() {
  const { profileId } = useApp();
  const scope = profileId || 'team';
  const confirm = useConfirm();
  const q = useLiveQueryStatus(() => db.savedReports.where('profileId').equals(scope).toArray(), [scope], []);
  const rows = useMemo(() => q.data.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), [q.data]);
  async function remove(r) {
    const ok = await confirm({ title: 'Eliminar vista', message: `¿Eliminar "${r.name}"?`, confirmLabel: 'Eliminar', tone: 'danger' });
    if (!ok) return;
    await db.savedReports.delete(r.id);
  }

  return (
    <AccountingGate title="Vistas guardadas">
      <PageHeader title="Vistas guardadas" subtitle="Tus reportes favoritos, listos para reabrir" />
      {!q.loaded ? <ListLoading /> : rows.length === 0 ? (
        <EmptyState icon={Bookmark} title="Sin vistas guardadas" description="Desde un reporte, usa “Guardar vista” para fijarlo aquí." />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="card p-3 flex items-center gap-3">
              <Bookmark size={15} className="text-ink-400 shrink-0" />
              <Link to={`${r.path}${r.search || ''}`} className="flex-1 min-w-0 hover:text-ink-900">
                <div className="font-medium truncate">{r.name}</div>
                <div className="text-xs text-ink-500">{ROUTE_LABEL[r.path] || r.path}{r.createdAt ? ` · ${formatDate(r.createdAt)}` : ''}</div>
              </Link>
              <button type="button" onClick={() => remove(r)} className="btn-icon text-ink-400" aria-label="Eliminar"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </AccountingGate>
  );
}
