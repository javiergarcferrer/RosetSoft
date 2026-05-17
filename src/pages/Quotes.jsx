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

// "#1001" or "borrador" — the internal-name field was removed; the
// number plus the customer chip in each row already identify the quote.
function describeQuote(q) {
  if (q.number != null) return `#${q.number}`;
  return 'borrador';
}

/**
 * Shared row-level mutations: delete confirm. The QuoteCard / QuoteRow
 * components have different layouts but identical row behavior — keep it
 * here so both stay in sync when (e.g.) the delete confirm copy changes.
 * Order assignment used to live here too (back when quotes pinned to
 * containers); it moved to the quote workspace (OrderChip) since order
 * creation is event-driven on quote-acceptance.
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

  return { del };
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
  const orders = useLiveQuery(
    () => db.orders.where('profileId').equals(profileId || '').toArray(),
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

  const ordersById = useMemo(() => {
    const m = new Map();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

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
            order={ordersById.get(qu.orderId)}
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
              <th>Cliente</th>
              <th>Estado</th>
              <th>Pedido</th>
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
                order={ordersById.get(qu.orderId)}
                total={totalByQuoteId.get(qu.id) || 0}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Compact read-only order indicator for a quote row. If the quote is in
// an order, link to it; if not, render a quiet em-dash. Quote→order
// attachment is event-driven (see OrderChip), so editing it from a list
// row would be misleading.
function OrderIndicator({ order }) {
  if (!order) return <span className="text-ink-300">—</span>;
  return (
    <Link
      to={`/orders/${order.id}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs font-medium text-ink-700 hover:text-brand-700 transition-colors"
    >
      <span className="tabular-nums">#{order.number ?? order.id.slice(-4)}</span>
      {order.name ? <span className="text-ink-500 truncate max-w-[120px]">· {order.name}</span> : null}
    </Link>
  );
}

function QuoteCard({ qu, customer, order, total }) {
  const { del } = useQuoteOps(qu);

  return (
    <div className="card p-3">
      <Link to={`/quotes/${qu.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">#{qu.number || '—'}</div>
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
        <div className="flex-1 min-w-0">
          <OrderIndicator order={order} />
        </div>
        <button onClick={del} className="text-ink-400 hover:text-red-600 p-2" aria-label="Eliminar">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function QuoteRow({ qu, customer, order, total }) {
  const { del } = useQuoteOps(qu);

  return (
    <tr className="cursor-pointer" onClick={() => (window.location.hash = `#/quotes/${qu.id}`)}>
      <td className="font-medium whitespace-nowrap">#{qu.number || '—'}</td>
      <td className="text-ink-700 truncate max-w-[160px]" title={customer?.name || ''}>{customer?.name || '—'}</td>
      <td><span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[qu.status] || 'bg-ink-100 text-ink-700'}`}>{STATUS_LABELS[qu.status] || 'Borrador'}</span></td>
      <td><OrderIndicator order={order} /></td>
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
