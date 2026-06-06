import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Package, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, invalidate, assignSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { resolveOrdersList } from '../core/quote/views/lists.js';
import { currentOrderStage } from '../lib/orderStages.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import ListLoading from '../components/ListLoading.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { orderStatusPill } from '../lib/statusPill.js';

/**
 * Orders list view — every order across the team, sorted by recency.
 *
 * An "order" is the operational unit that ties accepted quotes to the
 * physical containers fulfilling them. The list shows one row per order
 * with its status, customer, quote count, container count, and rolled-up
 * total (summed across the quotes attached). The status badge mirrors the
 * five-stage stepper that lives on the detail page.
 */

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

  // Everything the list renders — the per-order customer label and the
  // per-order rollups (total / quote count / container count) — is a pure
  // projection of the already-fetched rows. The page derives nothing itself;
  // it reads `customerLabelByOrderId` as a plain string per order and the
  // count/total Maps straight through (the del() handler reads the counts too).
  const {
    customerLabelByOrderId, totalByOrder, quoteCountByOrder, containerCountByOrder,
  } = useMemo(
    () => resolveOrdersList({
      orders, customers, quotes: allQuotes, containers: allContainers, lines: allLines,
    }),
    [orders, customers, allQuotes, allContainers, allLines],
  );

  async function newOrder() {
    const id = newId();
    const now = Date.now();
    // Race-safe assign: retries on the UNIQUE(profile_id, number)
    // constraint if another tab took our slot in flight.
    await assignSequenceNumber({
      table: 'orders',
      profileId,
      start: 101,
      build: (number) => ({
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
      }),
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
            customerLabel={customerLabelByOrderId.get(o.id)}
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
                customerLabel={customerLabelByOrderId.get(o.id)}
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
  return <StatusPill {...orderStatusPill(status)} />;
}

function OrderCard({ o, customerLabel, quoteCount, containerCount, total, onDelete }) {
  const stg = currentOrderStage(o);
  return (
    <div className="card card-interactive transition-all hover:shadow-md hover:-translate-y-0.5 p-3">
      <Link to={`/orders/${o.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold tabular-nums">
              #{o.number || '—'}{o.name ? <span className="font-normal text-ink-500"> · {o.name}</span> : ''}
            </div>
            {/* customerLabel is derived in the parent: direct
                order.customerId first, falling back to the customers
                attached via quotes. Only shows nothing when there's
                truly no customer connection in either direction. */}
            {customerLabel && (
              <div className="text-xs text-ink-500 truncate">{customerLabel}</div>
            )}
            <div className="text-[11px] text-ink-400 mt-1 tabular-nums">
              {quoteCount} cot. · {containerCount} cont. · {formatDateTime(o.updatedAt)}
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-semibold tabular-nums">{formatMoney(total, 'USD', { USD: 1 })}</div>
            <div className="mt-1"><StatusBadge status={stg} /></div>
          </div>
        </div>
      </Link>
      <div className="flex items-center justify-end mt-1">
        <button onClick={onDelete} className="text-ink-300 hover:text-red-600 p-2 -mr-2 min-h-11 coarse:min-h-11 transition-colors active:scale-95" aria-label="Eliminar">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function OrderRow({ o, customerLabel, quoteCount, containerCount, total, onDelete }) {
  const stg = currentOrderStage(o);
  return (
    <tr className="cursor-pointer transition-all hover:bg-ink-50/80 active:bg-ink-100" onClick={() => (window.location.hash = `#/orders/${o.id}`)}>
      <td className="font-medium whitespace-nowrap tabular-nums">#{o.number || '—'}</td>
      <td className="truncate max-w-[220px]" title={o.name || ''}>{o.name || '—'}</td>
      <td className="text-ink-700 truncate max-w-[180px]" title={customerLabel || ''}>{customerLabel || '—'}</td>
      <td><StatusBadge status={stg} /></td>
      <td className="hidden lg:table-cell text-ink-700 tabular-nums">{quoteCount}</td>
      <td className="hidden lg:table-cell text-ink-700 tabular-nums">{containerCount}</td>
      <td className="hidden xl:table-cell text-ink-400 whitespace-nowrap tabular-nums">{formatDateTime(o.updatedAt)}</td>
      <td className="text-right font-semibold whitespace-nowrap tabular-nums">{formatMoney(total, 'USD', { USD: 1 })}</td>
      <td className="text-right w-12">
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-ink-300 hover:text-red-600 transition-colors active:scale-95 p-1.5 rounded" title="Eliminar">
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}
