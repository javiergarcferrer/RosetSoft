import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Package, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, invalidate, nextSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { ORDER_STAGE_BY_KEY, currentOrderStage } from '../lib/orderStages.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import ListLoading from '../components/ListLoading.jsx';

/**
 * Orders list view — every order across the team, sorted by recency.
 *
 * An "order" is the operational unit that ties accepted quotes to the
 * physical containers fulfilling them. The list shows one row per order
 * with its status, customer, quote count, container count, and rolled-up
 * total (summed across the quotes attached). The status badge mirrors the
 * five-stage stepper that lives on the detail page.
 */

// Status palette mirroring the new 6-stage order lifecycle. Mapped onto
// the design-system status pills: confirmed reads as "committed money"
// (accepted-tone), received as "active", cancelled as "declined", and
// the two in-flight stages share the sent/pending blues + ambers.
const STATUS_PILL_CLASS = {
  draft:       'status-pill-draft',
  placed:      'status-pill-sent',
  confirmed:   'status-pill-accepted',
  in_transit:  'status-pill-sent',
  in_customs:  'status-pill-pending',
  received:    'status-pill-active',
  cancelled:   'status-pill-declined',
};

export default function Orders() {
  const { profileId } = useApp();

  // Gate the empty state on `loaded` — same reason as Customers / Quotes:
  // don't flash "Sin pedidos" on every navigation, only once we know it's
  // really empty.
  const { data: orders, loaded } = useLiveQueryStatus(
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

  // For each order, build the set of customer rows attached via its
  // quotes. Many orders are created from a quote (the OrderChip flow
  // pre-sets order.customerId), but some are created manually via
  // "Nuevo pedido" and never have a direct customer — they inherit
  // their customer from whichever quote(s) are attached. Without this
  // lookup the Pedidos list rendered "Sin cliente" for those orders,
  // which read as a data problem when it was just a display gap.
  const customersByOrder = useMemo(() => {
    const m = new Map();
    for (const q of allQuotes) {
      if (!q.orderId || !q.customerId) continue;
      const customer = customerById.get(q.customerId);
      if (!customer) continue;
      if (!m.has(q.orderId)) m.set(q.orderId, []);
      const list = m.get(q.orderId);
      if (!list.some((c) => c.id === customer.id)) list.push(customer);
    }
    return m;
  }, [allQuotes, customerById]);

  // Resolve the customer label for an order: prefer the direct
  // assignment (order.customerId), fall back to the quotes', cap
  // visible at the first customer plus "+N más" when several.
  function orderCustomerLabel(o) {
    const direct = o.customerId ? customerById.get(o.customerId) : null;
    if (direct) return direct.company || direct.name;
    const fromQuotes = customersByOrder.get(o.id) || [];
    if (fromQuotes.length === 0) return null;
    const head = fromQuotes[0].company || fromQuotes[0].name;
    return fromQuotes.length === 1 ? head : `${head} + ${fromQuotes.length - 1} más`;
  }

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
    const number = await nextSequenceNumber('orders', profileId, 101);
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

  if (!loaded) {
    return (
      <>
        <PageHeader title="Pedidos" />
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      </>
    );
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
            customerLabel={orderCustomerLabel(o)}
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
                customerLabel={orderCustomerLabel(o)}
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
    <span className={`status-pill ${STATUS_PILL_CLASS[status] || STATUS_PILL_CLASS.draft}`}>
      {def?.label || 'Borrador'}
    </span>
  );
}

function OrderCard({ o, customerLabel, quoteCount, containerCount, total, onDelete }) {
  const stg = currentOrderStage(o);
  return (
    <div className="card p-3">
      <Link to={`/orders/${o.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              #{o.number || '—'}{o.name ? ` · ${o.name}` : ''}
            </div>
            {/* customerLabel is derived in the parent: direct
                order.customerId first, falling back to the customers
                attached via quotes. Only shows nothing when there's
                truly no customer connection in either direction. */}
            {customerLabel && (
              <div className="text-xs text-ink-500 truncate">{customerLabel}</div>
            )}
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

function OrderRow({ o, customerLabel, quoteCount, containerCount, total, onDelete }) {
  const stg = currentOrderStage(o);
  return (
    <tr className="cursor-pointer" onClick={() => (window.location.hash = `#/orders/${o.id}`)}>
      <td className="font-medium whitespace-nowrap">#{o.number || '—'}</td>
      <td className="truncate max-w-[220px]" title={o.name || ''}>{o.name || '—'}</td>
      <td className="text-ink-700 truncate max-w-[180px]" title={customerLabel || ''}>{customerLabel || '—'}</td>
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
