import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Download, CheckCircle2, X, Search, ChevronRight, Undo2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import FulfillmentPills from '../components/FulfillmentPills.jsx';
import { DebouncedInput, DebouncedTextarea } from '../components/DebouncedInput.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { downloadCsv } from '../lib/csv.js';
import {
  STAGES, STAGE_BY_KEY,
  currentStage, nextStage, stageIndex,
} from '../lib/containerStages.js';

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

  // Stage transitions: advancing sets the timestamp on the target stage and
  // updates `stage`; undoing clears the timestamp and falls back to the
  // previous stage (so the dealer can recover from an accidental click).
  async function advanceTo(stage) {
    const ts = stage.timestampField;
    const patch = { stage: stage.key };
    if (ts) patch[ts] = Date.now();
    await updateContainer(patch);
  }
  async function undoStage(stage) {
    const ts = stage.timestampField;
    const idx = stageIndex(stage.key);
    const prev = STAGES[Math.max(0, idx - 1)];
    const patch = { stage: prev.key };
    if (ts) patch[ts] = null;
    await updateContainer(patch);
  }
  async function updateQuoteMilestone(quoteId, patch) {
    await db.quotes.update(quoteId, { ...patch, updatedAt: Date.now() });
  }

  function exportCsv() {
    // Lines now carry every field directly (no FK to a catalog), so the
    // export is a flat dump — no async resolution pass needed.
    const rows = [
      [
        'Container #', 'Container name', 'Container code', 'Container status',
        'Quote #', 'Quote name', 'Customer', 'Company',
        'Quote date', 'Family', 'Name', 'Subtype', 'Reference',
        'Dimensions', 'Page',
        'Qty', 'Unit price (USD)', 'Line total (USD)',
      ],
    ];
    for (const q of pinnedWithTotals) {
      if (!q.lines.length) {
        rows.push([
          container.number, container.name, container.code, currentStage(container),
          q.number, q.name, q.customer?.name || '', q.customer?.company || '',
          new Date(q.createdAt || Date.now()).toISOString().slice(0, 10),
          '', '', '', '', '', '', '', '', '', '',
        ]);
        continue;
      }
      for (const l of q.lines) {
        if (l.kind === 'section') continue; // headings aren't dispatchable
        const lineTotal = (l.qty || 0) * (l.unitPrice || 0);
        rows.push([
          container.number, container.name, container.code, currentStage(container),
          q.number, q.name, q.customer?.name || '', q.customer?.company || '',
          new Date(q.createdAt || Date.now()).toISOString().slice(0, 10),
          l.family || '', l.name || '', l.subtype || '', l.reference || '',
          l.dimensions || '', l.pageRef || '',
          l.qty || 0,
          (l.unitPrice || 0).toFixed(2),
          lineTotal.toFixed(2),
        ]);
      }
    }
    rows.push([]);
    rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Total (USD)', '', containerTotal.toFixed(2)]);
    downloadCsv(`Container-${container.number || container.id}.csv`, rows);
  }

  const stage = currentStage(container);
  const stageDef = STAGE_BY_KEY[stage];
  const next = nextStage(stage);

  return (
    <>
      <Link to="/containers" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 mb-3">
        <ArrowLeft size={12} /> Volver
      </Link>
      <PageHeader
        title={`Contenedor #${container.number}`}
        subtitle={`${stageDef.label} · Actualizado ${formatDateTime(container.updatedAt)}`}
        actions={
          <button onClick={exportCsv} className="btn-secondary"><Download size={14} /> Exportar CSV</button>
        }
      />

      <StageStepper
        container={container}
        stage={stage}
        next={next}
        onAdvance={advanceTo}
        onUndo={undoStage}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        <div className="lg:col-span-2 space-y-4">
          {/* Meta */}
          <div className="card card-pad space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="label">Nombre</div>
                <DebouncedInput
                  className="input"
                  value={container.name || ''}
                  onCommit={(v) => updateContainer({ name: v })}
                  placeholder='e.g. "Container Marzo — Santo Domingo"'
                />
              </div>
              <div>
                <div className="label">Código / referencia naviera</div>
                <DebouncedInput
                  className="input"
                  value={container.code || ''}
                  onCommit={(v) => updateContainer({ code: v })}
                  placeholder="MSCU1234567"
                />
              </div>
              <div className="sm:col-span-2">
                <div className="label">Notas</div>
                <DebouncedTextarea
                  className="input min-h-[60px]"
                  value={container.notes || ''}
                  onCommit={(v) => updateContainer({ notes: v })}
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
              /* Customer roll-up — one card per pinned quote, each with
                 fulfillment pills so the dealer can mark per-customer
                 milestones (notified / deposit / specs / balance /
                 delivery) without leaving this page. */
              <ul className="divide-y divide-ink-100">
                  {pinnedWithTotals.map((q) => (
                    <li key={q.id} className="p-3 sm:p-4">
                      <div className="flex items-start gap-3 flex-wrap">
                        <Link to={`/quotes/${q.id}`} className="flex-1 min-w-[200px] block">
                          <div className="text-sm font-semibold truncate">
                            #{q.number || '—'}{q.name ? ` · ${q.name}` : ''}
                          </div>
                          <div className="text-xs text-ink-700 truncate">{q.customer?.name || 'Sin cliente'}</div>
                          <div className="text-[11px] text-ink-500 mt-0.5">
                            {q.lines.length} {q.lines.length === 1 ? 'línea' : 'líneas'} · Act. {formatDateTime(q.updatedAt)}
                          </div>
                        </Link>
                        <div className="flex items-center gap-2 ml-auto">
                          <div className="text-sm font-medium tabular-nums whitespace-nowrap">{formatMoney(q.total, 'USD', { USD: 1 })}</div>
                          <button
                            onClick={() => unpin(q.id)}
                            className="text-ink-400 hover:text-red-600 p-1"
                            aria-label="Quitar del contenedor"
                            title="Quitar del contenedor"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      </div>
                      <div className="mt-2">
                        <FulfillmentPills quote={q} onChange={(p) => updateQuoteMilestone(q.id, p)} />
                      </div>
                    </li>
                  ))}
                </ul>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="card card-pad space-y-3">
            <h2 className="font-semibold text-sm">Revenue</h2>
            <div className="text-3xl font-semibold">{formatMoney(containerTotal, 'USD', { USD: 1 })}</div>
            <div className="text-xs text-ink-500">
              {pinnedWithTotals.length} {pinnedWithTotals.length === 1 ? 'cotización' : 'cotizaciones'}
            </div>
            {/* Dispatch-minimum bar matters during FILLING only — once the
                container has moved on, the threshold is history. */}
            {stage === 'filling' && (
              <>
                <div className="w-full h-2 bg-ink-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${ready ? 'bg-emerald-500' : 'bg-brand-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-xs">
                  {ready ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                      <CheckCircle2 size={12} /> Mínimo de {formatMoney(threshold, 'USD', { USD: 1 })} alcanzado
                    </span>
                  ) : (
                    <span className="text-ink-500">
                      Faltan {formatMoney(threshold - containerTotal, 'USD', { USD: 1 })} para el mínimo de despacho
                    </span>
                  )}
                </div>
              </>
            )}
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

            {/* Desktop table — fluid */}
            <div className="hidden md:block">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Cliente</th>
                    <th className="hidden lg:table-cell">Nombre</th>
                    <th className="hidden lg:table-cell">Líneas</th>
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
                        <td className="font-medium whitespace-nowrap">#{qu.number || '—'}</td>
                        <td className="text-ink-700 truncate max-w-[180px]" title={cust?.name || ''}>{cust?.name || '—'}</td>
                        <td className="hidden lg:table-cell truncate max-w-[200px]" title={qu.name || ''}>{qu.name || '—'}</td>
                        <td className="hidden lg:table-cell text-ink-500">{lines.length}</td>
                        <td className="text-right font-medium whitespace-nowrap">{formatMoney(total, 'USD', { USD: 1 })}</td>
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

function StageStepper({ container, stage, next, onAdvance, onUndo }) {
  const currentIdx = stageIndex(stage);
  const prev = currentIdx > 0 ? STAGES[currentIdx - 1] : null;
  const isComplete = stage === "complete";
  return (
    <div className="card card-pad space-y-4">
      {/* Horizontal stepper. Each cell renders the dot + label + date; a
          single track sits behind the dots showing progress. */}
      <div className="relative">
        <div className="absolute top-3 left-0 right-0 h-0.5 bg-ink-100" />
        <div
          className="absolute top-3 left-0 h-0.5 bg-brand-500 transition-all"
          style={{ width: `${(currentIdx / (STAGES.length - 1)) * 100}%` }}
        />
        <div className="relative flex justify-between gap-1">
          {STAGES.map((s, i) => {
            const ts = s.timestampField ? container[s.timestampField] : container.createdAt;
            const isPast = i < currentIdx;
            const isCurrent = i === currentIdx;
            return (
              <div key={s.key} className="flex flex-col items-center text-center flex-1 min-w-0">
                <div
                  className={`w-6 h-6 rounded-full border-2 z-10 flex items-center justify-center
                    ${isPast || (isCurrent && i === STAGES.length - 1)
                      ? "bg-brand-500 border-brand-500 text-white"
                      : isCurrent
                        ? "bg-white border-brand-500 ring-2 ring-brand-200"
                        : "bg-white border-ink-200"}`}
                >
                  {(isPast || (isCurrent && i === STAGES.length - 1)) && <CheckCircle2 size={12} />}
                </div>
                <div
                  className={`mt-1.5 text-[10px] font-semibold uppercase tracking-wide truncate w-full
                    ${isCurrent ? "text-brand-700" : isPast ? "text-ink-700" : "text-ink-400"}`}
                  title={s.label}
                >
                  {s.label}
                </div>
                <div className="text-[10px] text-ink-500 mt-0.5">
                  {ts ? new Date(ts).toLocaleDateString() : "—"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pt-3 border-t border-ink-100 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-500">Estado actual</div>
          <div className="text-sm font-semibold mt-0.5">{STAGE_BY_KEY[stage].label}</div>
          <div className="text-xs text-ink-500 mt-1">{STAGE_BY_KEY[stage].description}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {prev && (
            <button
              onClick={() => {
                if (confirm(`Regresar a ${prev.label}?`)) onUndo(STAGE_BY_KEY[stage]);
              }}
              className="btn-ghost text-xs"
              title="Volver al paso anterior"
            >
              <Undo2 size={12} /> Volver
            </button>
          )}
          {next ? (
            <button
              onClick={() => {
                if (confirm(`Avanzar a ${next.label}? Esto registra la transición con la fecha de hoy.`)) onAdvance(next);
              }}
              className="btn-primary"
            >
              Avanzar a {next.label} <ChevronRight size={14} />
            </button>
          ) : isComplete ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 text-sm font-medium">
              <CheckCircle2 size={14} /> Completado
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}


