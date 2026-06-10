import { useMemo, useState } from 'react';
import { Shield, Lock, LockOpen, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';

const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/**
 * Períodos contables — close a month so nothing can post into it (enforced by a
 * DB trigger across every path), reopen to amend. Self-gates on accounting/admin.
 */
export default function Periodos() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

  const periodsQ = useLiveQueryStatus(() => db.fiscalPeriods.where('profileId').equals(scope).toArray(), [scope], []);
  const byKey = useMemo(() => new Map(periodsQ.data.map((p) => [`${p.year}-${p.month}`, p])), [periodsQ.data]);
  const months = useMemo(() => {
    const now = new Date();
    const out = [];
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }
    return out;
  }, []);
  const [busy, setBusy] = useState(null);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Períodos contables" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  async function toggle(year, month) {
    const key = `${year}-${month}`;
    const row = byKey.get(key);
    const closed = row?.status === 'closed';
    setBusy(key);
    try {
      if (row) {
        await db.fiscalPeriods.update(row.id, { status: closed ? 'open' : 'closed', closedAt: closed ? null : Date.now() });
      } else {
        await db.fiscalPeriods.put({ id: newId(), profileId: scope, year, month, status: 'closed', closedAt: Date.now() });
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="Períodos contables"
        subtitle="Cierra un mes para que no se pueda asentar en él (se valida en la base de datos)" />

      {!periodsQ.loaded ? <ListLoading /> : (
        <div className="card overflow-hidden max-w-xl">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 px-3">Mes</th>
                <th className="text-left py-2 px-3">Estado</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {months.map(({ year, month }) => {
                const key = `${year}-${month}`;
                const closed = byKey.get(key)?.status === 'closed';
                return (
                  <tr key={key} className="border-t border-ink-50">
                    <td className="py-1.5 px-3">{MONTHS_ES[month - 1]} {year}</td>
                    <td className="py-1.5 px-3">
                      <span className={`status-pill ${closed ? 'bg-rose-100 text-rose-700' : 'status-pill-active'}`}>
                        {closed ? 'Cerrado' : 'Abierto'}
                      </span>
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <button type="button" onClick={() => toggle(year, month)} disabled={busy === key}
                        className="inline-flex items-center gap-1 rounded-md px-2 min-h-8 coarse:min-h-11 text-xs font-medium text-ink-600 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors disabled:opacity-40">
                        {busy === key ? <Loader2 size={13} className="animate-spin" /> : closed ? <LockOpen size={13} /> : <Lock size={13} />}
                        {closed ? 'Reabrir' : 'Cerrar'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
