import { useMemo, useState } from 'react';
import { Plus, Tag, Shield, Check } from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ListLoading from '../components/ListLoading.jsx';
import PromotionModal from '../components/PromotionModal.jsx';
import { formatDate } from '../lib/format.js';
import { isPromoActive, isPromoExpired, sortPromotions } from '../lib/promotions.js';

/**
 * Promociones admin page — the home for marketing "activaciones".
 *
 * The dealer captures each Ligne Roset promo here (name, code, window,
 * discount, eligible keywords, dealer-funded models); the quote builder then
 * applies it to quotes. Admin-only to edit (same gate as the other /admin
 * pages); RLS still lets any team member read so the apply flow works.
 */
export default function Promotions() {
  const { profileId, isAdmin } = useApp();
  const { data: promotions, loaded } = useLiveQueryStatus(
    () => db.promotions.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const [editing, setEditing] = useState(null);

  const rows = useMemo(() => sortPromotions(promotions), [promotions]);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Promociones" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Solo administradores pueden gestionar las promociones."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Promociones"
        subtitle={loaded ? `${promotions.length} ${promotions.length === 1 ? 'activación' : 'activaciones'}` : ' '}
        actions={<button onClick={() => setEditing({})} className="btn-primary"><Plus size={14} /> Nueva promoción</button>}
      />

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={4} /></div>
      ) : promotions.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="Sin promociones"
          description="Crea tu primera activación para aplicar su descuento a las cotizaciones."
          action={<button onClick={() => setEditing({})} className="btn-primary">Nueva promoción</button>}
        />
      ) : (
        <>
          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {rows.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setEditing(p)}
                className="card block w-full text-left hover:bg-ink-50 p-3"
              >
                <div className="flex items-center gap-2">
                  <div className="font-medium text-sm text-ink-900 truncate flex-1">{p.name || 'Sin nombre'}</div>
                  <StatusBadge promo={p} />
                </div>
                <div className="text-[11px] text-ink-500 mt-1 flex items-center gap-2 flex-wrap">
                  {p.code && <span className="font-mono">{p.code}</span>}
                  <span>{p.discountPct || 0}%</span>
                  <span>{windowLabel(p)}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Código</th>
                  <th>Descuento</th>
                  <th>Vigencia</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="cursor-pointer" onClick={() => setEditing(p)}>
                    <td className="font-medium truncate max-w-[260px]" title={p.name}>{p.name || 'Sin nombre'}</td>
                    <td className="font-mono text-ink-700">{p.code || '—'}</td>
                    <td className="text-ink-700">{p.discountPct || 0}%</td>
                    <td className="text-ink-700 whitespace-nowrap">{windowLabel(p)}</td>
                    <td><StatusBadge promo={p} /></td>
                    <td className="text-right w-20">
                      <span className="text-xs text-ink-500 hover:text-ink-900">Editar</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <PromotionModal promotion={editing} onClose={() => setEditing(null)} profileId={profileId} />
    </>
  );
}

function windowLabel(p) {
  const s = p.startsAt ? formatDate(p.startsAt) : null;
  const e = p.endsAt ? formatDate(p.endsAt) : null;
  if (s && e) return `${s} – ${e}`;
  if (s) return `desde ${s}`;
  if (e) return `hasta ${e}`;
  return 'sin fechas';
}

function StatusBadge({ promo }) {
  if (promo.isEnabled === false) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-ink-100 text-ink-500">Desactivada</span>;
  }
  if (isPromoExpired(promo)) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-ink-100 text-ink-500">Vencida</span>;
  }
  if (isPromoActive(promo)) {
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700"><Check size={10} /> Activa</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700">Programada</span>;
}
