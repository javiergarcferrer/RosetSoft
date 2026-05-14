import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Container as ContainerIcon, Trash2, CheckCircle2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';

const STATUS_STYLES = {
  open: 'bg-blue-100 text-blue-800',
  dispatched: 'bg-emerald-100 text-emerald-800',
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
      status: 'open',
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

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table min-w-[960px]">
            <thead>
            <tr>
              <th>Número</th>
              <th>Nombre</th>
              <th>Código</th>
              <th>Cotizaciones</th>
              <th>Estado</th>
              <th>Actualizado</th>
              <th className="text-right">Total (USD)</th>
              <th className="text-right">Progreso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => {
              const total = totalsByContainer.get(c.id) || 0;
              const count = quoteCountByContainer.get(c.id) || 0;
              const pct = threshold > 0 ? Math.min(100, (total / threshold) * 100) : 0;
              const ready = total >= threshold;
              return (
                <tr key={c.id} className="cursor-pointer" onClick={() => (window.location.hash = `#/containers/${c.id}`)}>
                  <td className="font-medium">#{c.number || '—'}</td>
                  <td>{c.name || '—'}</td>
                  <td className="font-mono text-xs text-ink-500">{c.code || '—'}</td>
                  <td className="text-ink-700">{count}</td>
                  <td>
                    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[c.status] || 'bg-ink-100 text-ink-700'}`}>
                      {c.status === 'dispatched' ? 'Despachado' : 'Abierto'}
                      {ready && c.status === 'open' && <CheckCircle2 size={11} />}
                    </span>
                  </td>
                  <td className="text-ink-500">{formatDateTime(c.updatedAt)}</td>
                  <td className="text-right font-medium">{formatMoney(total, 'USD', { USD: 1 })}</td>
                  <td className="text-right w-40">
                    <div className="flex items-center gap-2 justify-end">
                      <div className="w-24 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${ready ? 'bg-emerald-500' : 'bg-brand-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-ink-500 w-9 text-right">{Math.round(pct)}%</span>
                    </div>
                  </td>
                  <td className="text-right w-10">
                    <button
                      onClick={(e) => { e.stopPropagation(); del(c); }}
                      className="text-ink-400 hover:text-red-600"
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
      </div>
    </>
  );
}
