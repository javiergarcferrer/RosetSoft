import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Download, CheckCircle2, X, Search } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { downloadCsv } from '../lib/csv.js';

export default function ContainerDetail() {
  const { containerId } = useParams();
  const { profileId, settings } = useApp();
  const threshold = Number(settings?.dispatchThreshold) || 50000;

  const container = useLiveQuery(() => db.containers.get(containerId), [containerId], null);
  const pinnedQuotes = useLiveQuery(
    () => db.quotes.where('containerId').equals(containerId).toArray(),
    [containerId],
    [],
  );
  const allQuotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  const [picker, setPicker] = useState(false);

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);

  const linesByQuote = useMemo(() => {
    const m = new Map();
    for (const l of allLines) {
      const arr = m.get(l.quoteId) || [];
      arr.push(l);
      m.set(l.quoteId, arr);
    }
    return m;
  }, [allLines]);

  const pinnedWithTotals = useMemo(() => {
    return pinnedQuotes
      .map((q) => {
        const lines = linesByQuote.get(q.id) || [];
        const total = lines.reduce((acc, l) => acc + (l.qty || 0) * (l.unitPrice || 0), 0);
        return { ...q, lines, total, customer: customerById.get(q.customerId) };
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [pinnedQuotes, linesByQuote, customerById]);

  const containerTotal = pinnedWithTotals.reduce((acc, q) => acc + q.total, 0);
  const pct = threshold > 0 ? Math.min(100, (containerTotal / threshold) * 100) : 0;
  const ready = containerTotal >= threshold;

  if (!container) return <div className="text-sm text-ink-500">Cargando…</div>;

  async function updateContainer(patch) {
    await db.containers.put({ ...container, ...patch, updatedAt: Date.now() });
  }

  async function unpin(quoteId) {
    await db.quotes.update(quoteId, { containerId: null, updatedAt: Date.now() });
    await updateContainer({});
  }

  async function pin(quoteId) {
    await db.quotes.update(quoteId, { containerId: container.id, updatedAt: Date.now() });
    await updateContainer({});
    setPicker(false);
  }

  async function markDispatched() {
    if (!confirm(`Marcar el contenedor #${container.number} como despachado?`)) return;
    await updateContainer({ status: 'dispatched', dispatchedAt: Date.now() });
  }

  async function reopen() {
    await updateContainer({ status: 'open', dispatchedAt: null });
  }

  function exportCsv() {
    const variants = new Map();
    const products = new Map();
    const materials = new Map();
    const colors = new Map();
    // We'll resolve names asynchronously below.
    (async () => {
      const lineRefs = pinnedWithTotals.flatMap((q) => q.lines);
      const variantIds = [...new Set(lineRefs.map((l) => l.productVariantId).filter(Boolean))];
      const materialIds = [...new Set(lineRefs.map((l) => l.materialId).filter(Boolean))];
      const colorIds = [...new Set(lineRefs.map((l) => l.colorId).filter(Boolean))];

      for (const id of variantIds) {
        const v = await db.productVariants.get(id);
        if (v) {
          variants.set(id, v);
          if (v.productId && !products.has(v.productId)) {
            const p = await db.products.get(v.productId);
            if (p) products.set(v.productId, p);
          }
        }
      }
      for (const id of materialIds) {
        const m = await db.materials.get(id);
        if (m) materials.set(id, m);
      }
      for (const id of colorIds) {
        const c = await db.materialColors.get(id);
        if (c) colors.set(id, c);
      }

      const rows = [
        [
          'Container #', 'Container name', 'Container code', 'Container status',
          'Quote #', 'Quote name', 'Customer', 'Company',
          'Quote date', 'Product', 'Variant', 'Reference',
          'Material', 'Grade', 'Color',
          'Qty', 'Unit price (USD)', 'Line total (USD)',
        ],
      ];
      for (const q of pinnedWithTotals) {
        if (!q.lines.length) {
          rows.push([
            container.number, container.name, container.code, container.status,
            q.number, q.name, q.customer?.name || '', q.customer?.company || '',
            new Date(q.createdAt || Date.now()).toISOString().slice(0, 10),
            '', '', '', '', '', '', '', '', '',
          ]);
          continue;
        }
        for (const l of q.lines) {
          const v = variants.get(l.productVariantId);
          const p = v ? products.get(v.productId) : null;
          const m = materials.get(l.materialId);
          const c = colors.get(l.colorId);
          const lineTotal = (l.qty || 0) * (l.unitPrice || 0);
          rows.push([
            container.number, container.name, container.code, container.status,
            q.number, q.name, q.customer?.name || '', q.customer?.company || '',
            new Date(q.createdAt || Date.now()).toISOString().slice(0, 10),
            p?.name || '', v?.name || '', v?.reference || '',
            m?.name || '', m?.grade || '', c?.name || '',
            l.qty || 0,
            (l.unitPrice || 0).toFixed(2),
            lineTotal.toFixed(2),
          ]);
        }
      }
      rows.push([]);
      rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Total (USD)', '', '', containerTotal.toFixed(2)]);

      downloadCsv(`Container-${container.number || container.id}.csv`, rows);
    })();
  }

  return (
    <>
      <Link to="/containers" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 mb-3">
        <ArrowLeft size={12} /> Volver
      </Link>
      <PageHeader
        title={`Contenedor #${container.number}`}
        subtitle={`Actualizado ${formatDateTime(container.updatedAt)}${container.dispatchedAt ? ` · Despachado ${formatDateTime(container.dispatchedAt)}` : ''}`}
        actions={
          <>
            <button onClick={exportCsv} className="btn-secondary"><Download size={14} /> Exportar CSV</button>
            {container.status === 'dispatched' ? (
              <button onClick={reopen} className="btn-ghost">Reabrir</button>
            ) : (
              <button onClick={markDispatched} disabled={!ready} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
                <CheckCircle2 size={14} /> Marcar despachado
              </button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {/* Meta */}
          <div className="card card-pad space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="label">Nombre</div>
                <input
                  className="input"
                  value={container.name || ''}
                  onChange={(e) => updateContainer({ name: e.target.value })}
                  placeholder='e.g. "Container Marzo — Santo Domingo"'
                />
              </div>
              <div>
                <div className="label">Código / referencia naviera</div>
                <input
                  className="input"
                  value={container.code || ''}
                  onChange={(e) => updateContainer({ code: e.target.value })}
                  placeholder="MSCU1234567"
                />
              </div>
              <div className="sm:col-span-2">
                <div className="label">Notas</div>
                <textarea
                  className="input min-h-[60px]"
                  value={container.notes || ''}
                  onChange={(e) => updateContainer({ notes: e.target.value })}
                />
              </div>
            </div>
          </div>

          {/* Pinned quotes */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
              <h2 className="font-semibold">Cotizaciones fijadas ({pinnedWithTotals.length})</h2>
              <button onClick={() => setPicker(true)} className="btn-secondary">
                <Plus size={14} /> Fijar cotización
              </button>
            </div>
            {pinnedWithTotals.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-ink-500">
                Sin cotizaciones — usa <b>Fijar cotización</b> para añadir.
              </div>
            ) : (
              <>
                {/* Mobile cards */}
                <div className="md:hidden divide-y divide-ink-100">
                  {pinnedWithTotals.map((q) => (
                    <div key={q.id} className="p-3 flex items-start gap-2">
                      <Link to={`/quotes/${q.id}`} className="flex-1 min-w-0 block">
                        <div className="text-sm font-semibold">#{q.number || '—'}{q.name ? ` · ${q.name}` : ''}</div>
                        <div className="text-xs text-ink-700 truncate">{q.customer?.name || 'Sin cliente'}</div>
                        <div className="text-[11px] text-ink-500 mt-0.5">
                          {q.lines.length} {q.lines.length === 1 ? 'línea' : 'líneas'} · {formatDateTime(q.updatedAt)}
                        </div>
                      </Link>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <div className="text-sm font-medium">{formatMoney(q.total, 'USD', { USD: 1 })}</div>
                        <button
                          onClick={() => unpin(q.id)}
                          className="text-ink-400 hover:text-red-600 p-1 -mr-1"
                          aria-label="Quitar del contenedor"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="table min-w-[720px]">
                    <thead>
                      <tr>
                        <th>Número</th>
                        <th>Cliente</th>
                        <th>Nombre</th>
                        <th>Líneas</th>
                        <th>Actualizado</th>
                        <th className="text-right">Total</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {pinnedWithTotals.map((q) => (
                        <tr key={q.id}>
                          <td className="font-medium">
                            <Link to={`/quotes/${q.id}`} className="hover:underline">#{q.number || '—'}</Link>
                          </td>
                          <td className="text-ink-700">{q.customer?.name || '—'}</td>
                          <td>{q.name || '—'}</td>
                          <td className="text-ink-500">{q.lines.length}</td>
                          <td className="text-ink-500">{formatDateTime(q.updatedAt)}</td>
                          <td className="text-right font-medium">{formatMoney(q.total, 'USD', { USD: 1 })}</td>
                          <td className="text-right w-8">
                            <button onClick={() => unpin(q.id)} className="text-ink-400 hover:text-red-600" title="Quitar del contenedor">
                              <X size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="card card-pad space-y-3">
            <h2 className="font-semibold text-sm">Progreso de despacho</h2>
            <div className="text-3xl font-semibold">{formatMoney(containerTotal, 'USD', { USD: 1 })}</div>
            <div className="text-xs text-ink-500">de {formatMoney(threshold, 'USD', { USD: 1 })} mínimo</div>
            <div className="w-full h-2 bg-ink-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${ready ? 'bg-emerald-500' : 'bg-brand-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-xs">
              {ready ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                  <CheckCircle2 size={12} /> Listo para despacho
                </span>
              ) : (
                <span className="text-ink-500">
                  Faltan {formatMoney(threshold - containerTotal, 'USD', { USD: 1 })}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <QuotePickerModal
        open={picker}
        onClose={() => setPicker(false)}
        onPick={pin}
        quotes={allQuotes}
        customers={customerById}
        linesByQuote={linesByQuote}
        currentContainerId={container.id}
      />
    </>
  );
}

function QuotePickerModal({ open, onClose, onPick, quotes, customers, linesByQuote, currentContainerId }) {
  const [q, setQ] = useState('');
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return quotes
      .filter((qu) => !qu.containerId || qu.containerId === currentContainerId)
      .filter((qu) => qu.containerId !== currentContainerId)
      .filter((qu) => {
        if (!needle) return true;
        const cust = customers.get(qu.customerId);
        return (
          (qu.number || '').toString().includes(needle) ||
          (qu.name || '').toLowerCase().includes(needle) ||
          (cust?.name || '').toLowerCase().includes(needle) ||
          (cust?.company || '').toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50);
  }, [quotes, q, customers, currentContainerId]);

  return (
    <Modal open={open} onClose={onClose} title="Fijar cotización al contenedor" size="lg">
      <div className="mb-3 relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          autoFocus
          className="input pl-9"
          placeholder="Buscar por número, nombre o cliente…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        {candidates.length === 0 ? (
          <div className="text-center text-sm text-ink-500 py-8">Sin cotizaciones disponibles.</div>
        ) : (
          <>
            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-ink-100">
              {candidates.map((qu) => {
                const lines = linesByQuote.get(qu.id) || [];
                const total = lines.reduce((acc, l) => acc + (l.qty || 0) * (l.unitPrice || 0), 0);
                const cust = customers.get(qu.customerId);
                return (
                  <button
                    key={qu.id}
                    onClick={() => onPick(qu.id)}
                    className="w-full text-left p-3 flex items-start justify-between gap-2 hover:bg-ink-50 active:bg-ink-100"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">#{qu.number || '—'}{qu.name ? ` · ${qu.name}` : ''}</div>
                      <div className="text-xs text-ink-700 truncate">{cust?.name || 'Sin cliente'}</div>
                      <div className="text-[11px] text-ink-500 mt-0.5">{lines.length} {lines.length === 1 ? 'línea' : 'líneas'}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-medium">{formatMoney(total, 'USD', { USD: 1 })}</div>
                      <div className="text-[11px] text-brand-600 mt-0.5">Fijar →</div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Cliente</th>
                    <th>Nombre</th>
                    <th>Líneas</th>
                    <th className="text-right">Total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((qu) => {
                    const lines = linesByQuote.get(qu.id) || [];
                    const total = lines.reduce((acc, l) => acc + (l.qty || 0) * (l.unitPrice || 0), 0);
                    const cust = customers.get(qu.customerId);
                    return (
                      <tr key={qu.id}>
                        <td className="font-medium">#{qu.number || '—'}</td>
                        <td className="text-ink-700">{cust?.name || '—'}</td>
                        <td>{qu.name || '—'}</td>
                        <td className="text-ink-500">{lines.length}</td>
                        <td className="text-right font-medium">{formatMoney(total, 'USD', { USD: 1 })}</td>
                        <td className="text-right">
                          <button onClick={() => onPick(qu.id)} className="text-xs text-brand-600 hover:underline">
                            Fijar →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
