import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { Plus, Search, FileText, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';

const STATUS_STYLES = {
  draft: 'bg-ink-100 text-ink-700',
  sent: 'bg-blue-100 text-blue-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  declined: 'bg-red-100 text-red-800',
  archived: 'bg-ink-100 text-ink-500',
};

const STATUS_LABELS = {
  draft: 'Borrador',
  sent: 'Enviada',
  accepted: 'Aceptada',
  declined: 'Rechazada',
  archived: 'Archivada',
};

// "#123 · Smith residence" / "#123" / "Smith residence" / "borrador sin nombre"
function describeQuote(q) {
  if (q.number != null && q.name) return `#${q.number} · ${q.name}`;
  if (q.number != null) return `#${q.number}`;
  if (q.name) return q.name;
  return 'borrador sin nombre';
}

/**
 * Shared row-level mutations: delete confirm, container assignment. The
 * QuoteCard / QuoteRow components have different layouts but identical
 * row behavior — keep it here so both stay in sync when (e.g.) the delete
 * confirm copy changes. Totals are passed in as a prop because the parent
 * fetches them all in a single batch.
 */
function useQuoteOps(qu) {
  async function del(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`¿Eliminar la cotización ${describeQuote(qu)}?`)) return;
    const lines = await db.quoteLines.where('quoteId').equals(qu.id).toArray();
    await db.quoteLines.bulkDelete(lines.map((l) => l.id));
    await db.quotes.delete(qu.id);
  }

  async function setContainer(e) {
    e.stopPropagation();
    const value = e.target.value || null;
    await db.quotes.update(qu.id, { containerId: value, updatedAt: Date.now() });
  }

  return { del, setContainer };
}

export default function Quotes() {
  const { profileId } = useApp();
  const quotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').reverse().sortBy('updatedAt'),
    [profileId],
    []
  );
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    []
  );
  const containers = useLiveQuery(
    () => db.containers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    []
  );
  // Batch fetch lines once → derive per-quote totals in O(N+M) instead of
  // N round-trips for N visible quotes. Cheaper for the dashboard's six
  // recent quotes and an order of magnitude cheaper for the full list page.
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  const customerById = useMemo(() => {
    const m = new Map();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  const totalByQuoteId = useMemo(() => {
    const m = new Map();
    for (const l of allLines) {
      m.set(l.quoteId, (m.get(l.quoteId) || 0) + (l.qty || 0) * (l.unitPrice || 0));
    }
    return m;
  }, [allLines]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return quotes
      .filter((q) => (status ? q.status === status : true))
      .filter((qu) => {
        if (!needle) return true;
        const cust = customerById.get(qu.customerId);
        return (
          (qu.number || '').toString().includes(needle) ||
          (qu.name || '').toLowerCase().includes(needle) ||
          (cust?.name || '').toLowerCase().includes(needle) ||
          (cust?.company || '').toLowerCase().includes(needle)
        );
      });
  }, [quotes, q, status, customerById]);

  if (!quotes.length) {
    return (
      <>
        <PageHeader title="Cotizaciones" />
        <EmptyState
          icon={FileText}
          title="Sin cotizaciones"
          description="Crea tu primera cotización. Elige un producto, una tela y color, ajusta la cantidad."
          action={<Link to="/quotes/new" className="btn-primary">Nueva cotización</Link>}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Cotizaciones"
        subtitle={`${quotes.length} ${quotes.length === 1 ? 'cotización' : 'cotizaciones'}`}
        actions={<Link to="/quotes/new" className="btn-primary"><Plus size={14} /> Nueva cotización</Link>}
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            className="input pl-9"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por número o cliente…"
          />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="input max-w-[160px]">
          <option value="">Todos los estados</option>
          <option value="draft">Borrador</option>
          <option value="sent">Enviada</option>
          <option value="accepted">Aceptada</option>
          <option value="declined">Rechazada</option>
          <option value="archived">Archivada</option>
        </select>
      </div>

      {/* Mobile: cards */}
      <div className="md:hidden space-y-2">
        {filtered.map((qu) => (
          <QuoteCard
            key={qu.id}
            qu={qu}
            customer={customerById.get(qu.customerId)}
            allContainers={containers}
            total={totalByQuoteId.get(qu.id) || 0}
          />
        ))}
        {filtered.length === 0 && (
          <div className="card card-pad text-center text-sm text-ink-500">Sin coincidencias.</div>
        )}
      </div>

      {/* Desktop: table. No overflow wrapper — columns compress to the
          container, and low-priority columns hide below lg so the table
          stays within its width regardless of viewport / PDF panel state. */}
      <div className="hidden md:block card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Número</th>
              <th className="hidden lg:table-cell">Nombre</th>
              <th>Cliente</th>
              <th>Estado</th>
              <th>Contenedor</th>
              <th className="hidden lg:table-cell">Actualizada</th>
              <th className="text-right">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((qu) => (
              <QuoteRow
                key={qu.id}
                qu={qu}
                customer={customerById.get(qu.customerId)}
                allContainers={containers}
                total={totalByQuoteId.get(qu.id) || 0}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function QuoteCard({ qu, customer, allContainers, total }) {
  const { del, setContainer } = useQuoteOps(qu);

  return (
    <div className="card p-3">
      <Link to={`/quotes/${qu.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">#{qu.number || '—'}{qu.name ? ` · ${qu.name}` : ''}</div>
            <div className="text-xs text-ink-500 truncate">{customer?.name || 'Sin cliente'}</div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-medium">{formatMoney(total, qu.currencyCode || 'USD', qu.rates || { USD: 1 })}</div>
            <div className="text-[10px] text-ink-500">{formatDateTime(qu.updatedAt)}</div>
          </div>
        </div>
      </Link>
      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-ink-100">
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[qu.status] || 'bg-ink-100 text-ink-700'}`}>{STATUS_LABELS[qu.status] || 'Borrador'}</span>
        <select
          className="input text-xs py-1 flex-1 min-w-0"
          value={qu.containerId || ''}
          onChange={setContainer}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="">— Sin contenedor —</option>
          {allContainers.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.number}{c.name ? ` · ${c.name}` : ''}
            </option>
          ))}
        </select>
        <button onClick={del} className="text-ink-400 hover:text-red-600 p-2" aria-label="Eliminar">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function QuoteRow({ qu, customer, allContainers, total }) {
  const { del, setContainer } = useQuoteOps(qu);

  return (
    <tr className="cursor-pointer" onClick={() => (window.location.hash = `#/quotes/${qu.id}`)}>
      <td className="font-medium whitespace-nowrap">#{qu.number || '—'}</td>
      <td className="hidden lg:table-cell max-w-[200px] truncate" title={qu.name || ''}>{qu.name || '—'}</td>
      <td className="text-ink-700 truncate max-w-[160px]" title={customer?.name || ''}>{customer?.name || '—'}</td>
      <td><span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[qu.status] || 'bg-ink-100 text-ink-700'}`}>{STATUS_LABELS[qu.status] || 'Borrador'}</span></td>
      <td onClick={(e) => e.stopPropagation()}>
        <select
          className="input text-xs py-1 w-full max-w-[180px]"
          value={qu.containerId || ''}
          onChange={setContainer}
        >
          <option value="">— Ninguno —</option>
          {allContainers.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.number}{c.name ? ` · ${c.name}` : ''}
            </option>
          ))}
        </select>
      </td>
      <td className="hidden lg:table-cell text-ink-500 whitespace-nowrap">{formatDateTime(qu.updatedAt)}</td>
      <td className="text-right font-medium whitespace-nowrap">{formatMoney(total, qu.currencyCode || 'USD', qu.rates || { USD: 1 })}</td>
      <td className="text-right w-12">
        <button onClick={del} className="text-ink-400 hover:text-red-600" title="Eliminar">
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}
