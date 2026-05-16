import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Container as ContainerIcon, Trash2, CheckCircle2, Star } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { STAGE_BY_KEY, currentStage } from '../lib/containerStages.js';

const STAGE_STYLES = {
  filling:    'bg-blue-100 text-blue-800',
  submitting: 'bg-amber-100 text-amber-800',
  ordered:    'bg-violet-100 text-violet-800',
  in_transit: 'bg-sky-100 text-sky-800',
  landing:    'bg-orange-100 text-orange-800',
  complete:   'bg-emerald-100 text-emerald-800',
};

export default function Containers() {
  const { profileId, settings, saveSettings } = useApp();
  const threshold = Number(settings?.dispatchThreshold) || 50000;

  const containers = useLiveQuery(
    () => db.containers.where('profileId').equals(profileId || '').reverse().sortBy('updatedAt'),
    [profileId],
    [],
  );

  const allQuotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  const defaultContainerId = settings?.defaultContainerId || null;

  async function setDefault(id) {
    await saveSettings({ defaultContainerId: id });
  }
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);

  const { totalsByContainer, quoteCountByContainer } = useMemo(() => {
    const lineTotalByQuote = new Map();
    for (const l of allLines) {
      const t = (l.qty || 0) * (l.unitPrice || 0);
      lineTotalByQuote.set(l.quoteId, (lineTotalByQuote.get(l.quoteId) || 0) + t);
    }
    const totalsByContainer = new Map();
    const quoteCountByContainer = new Map();
    for (const q of allQuotes) {
      if (!q.containerId) continue;
      const t = lineTotalByQuote.get(q.id) || 0;
      totalsByContainer.set(q.containerId, (totalsByContainer.get(q.containerId) || 0) + t);
      quoteCountByContainer.set(q.containerId, (quoteCountByContainer.get(q.containerId) || 0) + 1);
    }
    return { totalsByContainer, quoteCountByContainer };
  }, [allQuotes, allLines]);

  async function newContainer() {
    const number = (settings?.containerCounter || 100) + 1;
    const id = newId();
    await db.containers.put({
      id,
      profileId,
      number,
      name: '',
      code: '',
      stage: 'filling',
      notes: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await saveSettings({ containerCounter: number });
    window.location.hash = `#/containers/${id}`;
  }

  async function del(c) {
    if (!confirm(`Eliminar el contenedor #${c.number}? Las cotizaciones fijadas quedarán libres.`)) return;
    await db.containers.delete(c.id);
  }

  if (!containers.length) {
    return (
      <>
        <PageHeader title="Contenedores" />
        <EmptyState
          icon={ContainerIcon}
          title="Sin contenedores"
          description="Agrupa cotizaciones en contenedores para hacer seguimiento de despachos."
          action={<button onClick={newContainer} className="btn-primary">Crear contenedor</button>}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Contenedores"
        subtitle={`${containers.length} contenedor${containers.length === 1 ? '' : 'es'} · Mínimo de despacho ${formatMoney(threshold, 'USD', { USD: 1 })}`}
        actions={<button onClick={newContainer} className="btn-primary"><Plus size={14} /> Nuevo</button>}
      />

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {containers.map((c) => {
          const total = totalsByContainer.get(c.id) || 0;
          const count = quoteCountByContainer.get(c.id) || 0;
          const pct = threshold > 0 ? Math.min(100, (total / threshold) * 100) : 0;
          const ready = total >= threshold;
          const stg = currentStage(c);
          const stageDef = STAGE_BY_KEY[stg];
          const isDefault = defaultContainerId === c.id;
          return (
            <div key={c.id} className="card p-3">
              <Link to={`/containers/${c.id}`} className="block">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm inline-flex items-center gap-1.5">
                      #{c.number || '—'}{c.name ? ` · ${c.name}` : ''}
                      {isDefault && <Star size={12} className="text-amber-500 fill-amber-500" aria-label="Contenedor por defecto" />}
                    </div>
                    {c.code && <div className="font-mono text-[11px] text-ink-500">{c.code}</div>}
                    <div className="text-[11px] text-ink-500 mt-1">
                      {count} {count === 1 ? 'cotización' : 'cotizaciones'} · {formatDateTime(c.updatedAt)}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-medium">{formatMoney(total, 'USD', { USD: 1 })}</div>
                    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium mt-1 ${STAGE_STYLES[stg]}`}>
                      {stageDef.label}
                      {stg === 'filling' && ready && <CheckCircle2 size={10} />}
                    </span>
                  </div>
                </div>
                {stg === 'filling' && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${ready ? 'bg-emerald-500' : 'bg-brand-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-ink-500 w-9 text-right">{Math.round(pct)}%</span>
                  </div>
                )}
              </Link>
              <div className="flex items-center justify-between mt-1">
                <button
                  onClick={() => setDefault(isDefault ? null : c.id)}
                  className={`text-xs inline-flex items-center gap-1 p-2 -ml-2 ${
                    isDefault ? 'text-amber-600' : 'text-ink-400 hover:text-amber-600'
                  }`}
                  aria-label={isDefault ? 'Quitar como predeterminado' : 'Marcar como predeterminado'}
                  title={isDefault ? 'Predeterminado · toca para quitar' : 'Marcar como contenedor predeterminado para nuevas cotizaciones'}
                >
                  <Star size={14} className={isDefault ? 'fill-current' : ''} />
                  {isDefault ? 'Predeterminado' : 'Hacer predeterminado'}
                </button>
                <button
                  onClick={() => del(c)}
                  className="text-ink-400 hover:text-red-600 p-2 -mr-2 -mb-1"
                  aria-label="Eliminar"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop table — fluid columns, low-priority cells hide at sub-xl. */}
      <div className="hidden md:block card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Nombre</th>
              <th className="hidden xl:table-cell">Código</th>
              <th className="hidden lg:table-cell">Cot.</th>
              <th>Estado</th>
              <th className="hidden xl:table-cell">Actualizado</th>
              <th className="text-right">Total</th>
              <th className="text-right hidden lg:table-cell">Progreso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => {
              const total = totalsByContainer.get(c.id) || 0;
              const count = quoteCountByContainer.get(c.id) || 0;
              const pct = threshold > 0 ? Math.min(100, (total / threshold) * 100) : 0;
              const ready = total >= threshold;
              const stg = currentStage(c);
              const stageDef = STAGE_BY_KEY[stg];
              const isDefault = defaultContainerId === c.id;
              return (
                <tr key={c.id} className="cursor-pointer" onClick={() => (window.location.hash = `#/containers/${c.id}`)}>
                  <td className="font-medium whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {isDefault && <Star size={12} className="text-amber-500 fill-amber-500" aria-label="Contenedor por defecto" />}
                      #{c.number || '—'}
                    </span>
                  </td>
                  <td className="truncate max-w-[200px]" title={c.name || ''}>{c.name || '—'}</td>
                  <td className="hidden xl:table-cell font-mono text-xs text-ink-500 truncate max-w-[140px]" title={c.code || ''}>{c.code || '—'}</td>
                  <td className="hidden lg:table-cell text-ink-700">{count}</td>
                  <td>
                    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${STAGE_STYLES[stg]}`}>
                      {stageDef.label}
                      {stg === 'filling' && ready && <CheckCircle2 size={11} />}
                    </span>
                  </td>
                  <td className="hidden xl:table-cell text-ink-500 whitespace-nowrap">{formatDateTime(c.updatedAt)}</td>
                  <td className="text-right font-medium whitespace-nowrap">{formatMoney(total, 'USD', { USD: 1 })}</td>
                  <td className="hidden lg:table-cell text-right w-40">
                    {stg === 'filling' ? (
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-24 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${ready ? 'bg-emerald-500' : 'bg-brand-500'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[11px] text-ink-500 w-9 text-right">{Math.round(pct)}%</span>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-400">—</span>
                    )}
                  </td>
                  <td className="text-right w-20 whitespace-nowrap">
                    <button
                      onClick={(e) => { e.stopPropagation(); setDefault(isDefault ? null : c.id); }}
                      className={`p-1 mr-0.5 ${isDefault ? 'text-amber-500' : 'text-ink-300 hover:text-amber-500'}`}
                      title={isDefault ? 'Predeterminado · clic para quitar' : 'Marcar como predeterminado'}
                      aria-label={isDefault ? 'Quitar como predeterminado' : 'Marcar como predeterminado'}
                    >
                      <Star size={13} className={isDefault ? 'fill-current' : ''} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); del(c); }}
                      className="text-ink-400 hover:text-red-600 p-1"
                      title="Eliminar"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
