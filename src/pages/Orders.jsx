import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Package, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, invalidate } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { ORDER_STAGE_BY_KEY, currentOrderStage } from '../lib/orderStages.js';

/**
 * Orders list view — every order across the team, sorted by recency.
 *
 * An "order" is the operational unit that ties accepted quotes to the
 * physical containers fulfilling them. The list shows one row per order
 * with its status, customer, quote count, container count, and rolled-up
 * total (summed across the quotes attached). The status badge mirrors the
 * five-stage stepper that lives on the detail page.
 */

const STATUS_STYLES = {
  draft:            'bg-ink-100 text-ink-700',
  accepted:         'bg-blue-100 text-blue-800',
  deposit_received: 'bg-amber-100 text-amber-800',
  placed:           'bg-violet-100 text-violet-800',
  delivered:        'bg-emerald-100 text-emerald-800',
  cancelled:        'bg-rose-100 text-rose-700',
};

export default function Orders() {
  const { profileId, settings, saveSettings } = useApp();

  const orders = useLiveQuery(
    () => db.orders.where('profileId').equals(profileId || '').reverse().sortBy('updatedAt'),
    [profileId],
    [],
  );

  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  const allQuotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  const allContainers = useLiveQuery(
    () => db.containers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  // Batch the lines once; per-order totals are O(N) over lines + O(M) over
  // quotes vs N round-trips for N visible orders.
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);

  const customerById = useMemo(() => {
    const m = new Map();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  const { totalByOrder, quoteCountByOrder, containerCountByOrder } = useMemo(() => {
    const lineTotalByQuote = new Map();
    for (const l of allLines) {
      const t = (l.qty || 0) * (l.unitPrice || 0);
      lineTotalByQuote.set(l.quoteId, (lineTotalByQuote.get(l.quoteId) || 0) + t);
    }
    const totalByOrder = new Map();
    const quoteCountByOrder = new Map();
    for (const q of allQuotes) {
      if (!q.orderId) continue;
      const t = lineTotalByQuote.get(q.id) || 0;
      totalByOrder.set(q.orderId, (totalByOrder.get(q.orderId) || 0) + t);
      quoteCountByOrder.set(q.orderId, (quoteCountByOrder.get(q.orderId) || 0) + 1);
    }
    const containerCountByOrder = new Map();
    for (const c of allContainers) {
      if (!c.orderId) continue;
      containerCountByOrder.set(c.orderId, (containerCountByOrder.get(c.orderId) || 0) + 1);
    }
    return { totalByOrder, quoteCountByOrder, containerCountByOrder };
  }, [allQuotes, allLines, allContainers]);

  async function newOrder() {
    const number = (settings?.orderCounter || 100) + 1;
    const id = newId();
    const now = Date.now();
    await db.orders.put({
      id,
      profileId,
      number,
      name: '',
      customerId: null,
      status: 'draft',
      notes: '',
      depositAmount: 0,
      deliveryAddress: '',
      createdAt: now,
      updatedAt: now,
    });
    await saveSettings({ orderCounter: number });
    window.location.hash = `#/orders/${id}`;
  }

  async function del(order) {
    const n = quoteCountByOrder.get(order.id) || 0;
    const c = containerCountByOrder.get(order.id) || 0;
    const tag = `#${order.number || '—'}`;
    let msg = `¿Eliminar el pedido ${tag}?`;
    if (n || c) {
      msg += `\n\nLas ${n} cotizaciones y ${c} contenedores vinculados quedarán libres (no se eliminan).`;
    }
    if (!confirm(msg)) return;
    await db.orders.delete(order.id);
    invalidate();
  }

  if (!orders.length) {
    return (
      <>
        <PageHeader title="Pedidos" />
        <EmptyState
          icon={Package}
          title="Sin pedidos"
          description="Cuando aceptes una cotización, crea un pedido para seguir su fulfillment hasta entrega."
          action={<button onClick={newOrder} className="btn-primary">Crear pedido</button>}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Pedidos"
        subtitle={`${orders.length} pedido${orders.length === 1 ? '' : 's'}`}
        actions={<button onClick={newOrder} className="btn-primary"><Plus size={14} /> Nuevo</button>}
      />

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {orders.map((o) => (
          <OrderCard
            key={o.id}
            o={o}
            customer={customerById.get(o.customerId)}
            quoteCount={quoteCountByOrder.get(o.id) || 0}
            containerCount={containerCountByOrder.get(o.id) || 0}
            total={totalByOrder.get(o.id) || 0}
            onDelete={() => del(o)}
          />
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Nombre</th>
              <th>Cliente</th>
              <th>Estado</th>
              <th className="hidden lg:table-cell">Cot.</th>
              <th className="hidden lg:table-cell">Cont.</th>
              <th className="hidden xl:table-cell">Actualizado</th>
              <th className="text-right">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <OrderRow
                key={o.id}
                o={o}
                customer={customerById.get(o.customerId)}
                quoteCount={quoteCountByOrder.get(o.id) || 0}
                containerCount={containerCountByOrder.get(o.id) || 0}
                total={totalByOrder.get(o.id) || 0}
                onDelete={() => del(o)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StatusBadge({ status }) {
  const def = ORDER_STAGE_BY_KEY[status];
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] || STATUS_STYLES.draft}`}>
      {def?.label || 'Borrador'}
    </span>
  );
}

function OrderCard({ o, customer, quoteCount, containerCount, total, onDelete }) {
  const stg = currentOrderStage(o);
  return (
    <div className="card p-3">
      <Link to={`/orders/${o.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              #{o.number || '—'}{o.name ? ` · ${o.name}` : ''}
            </div>
            <div className="text-xs text-ink-500 truncate">
              {customer?.name || 'Sin cliente'}
            </div>
            <div className="text-[11px] text-ink-500 mt-1">
              {quoteCount} cot. · {containerCount} cont. · {formatDateTime(o.updatedAt)}
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-medium">{formatMoney(total, 'USD', { USD: 1 })}</div>
            <div className="mt-1"><StatusBadge status={stg} /></div>
          </div>
        </div>
      </Link>
      <div className="flex items-center justify-end mt-1">
        <button onClick={onDelete} className="text-ink-400 hover:text-red-600 p-2 -mr-2" aria-label="Eliminar">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function OrderRow({ o, customer, quoteCount, containerCount, total, onDelete }) {
  const stg = currentOrderStage(o);
  return (
    <tr className="cursor-pointer" onClick={() => (window.location.hash = `#/orders/${o.id}`)}>
      <td className="font-medium whitespace-nowrap">#{o.number || '—'}</td>
      <td className="truncate max-w-[220px]" title={o.name || ''}>{o.name || '—'}</td>
      <td className="text-ink-700 truncate max-w-[180px]" title={customer?.name || ''}>{customer?.name || '—'}</td>
      <td><StatusBadge status={stg} /></td>
      <td className="hidden lg:table-cell text-ink-700">{quoteCount}</td>
      <td className="hidden lg:table-cell text-ink-700">{containerCount}</td>
      <td className="hidden xl:table-cell text-ink-500 whitespace-nowrap">{formatDateTime(o.updatedAt)}</td>
      <td className="text-right font-medium whitespace-nowrap">{formatMoney(total, 'USD', { USD: 1 })}</td>
      <td className="text-right w-12">
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-ink-400 hover:text-red-600" title="Eliminar">
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}
