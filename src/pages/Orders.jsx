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
import { viewerCompanySettings } from '../core/quote/index.js';
import { currentOrderStage } from '../lib/orderStages.js';
import { reconcileQuoteStock } from '../lib/lsgStock.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import ListLoading from '../components/ListLoading.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { orderStatusPill } from '../lib/statusPill.js';
import useColumns from '../components/search/useColumns.js';
import useColumnWidths from '../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../components/search/ColumnsMenu.jsx';

/**
 * Desktop table columns (Shopify-orders-style customizable list). ONE ordered
 * definition drives both the table render (`cell`) and the Columns menu
 * (`label` / `canHide`). `number` is the fixed identity anchor (`canHide:
 * false`) — never hidden, not offered in the menu; everything else toggles.
 * Each `cell` is a pure render off the per-row `ctx` the row assembles.
 */
const ORDER_COLUMNS = [
  {
    key: 'number', label: 'Número', canHide: false,
    tdClass: 'font-medium whitespace-nowrap tabular-nums',
    cell: ({ o }) => `#${o.number || '—'}`,
  },
  {
    key: 'name', label: 'Nombre',
    tdClass: 'truncate max-w-[220px]',
    cell: ({ o }) => <span title={o.name || ''}>{o.name || '—'}</span>,
  },
  {
    key: 'customer', label: 'Cliente',
    tdClass: 'text-ink-700 truncate max-w-[180px]',
    cell: ({ customerLabel }) => <span title={customerLabel || ''}>{customerLabel || '—'}</span>,
  },
  {
    key: 'status', label: 'Estado',
    cell: ({ stg }) => <StatusBadge status={stg} />,
  },
  {
    key: 'quotes', label: 'Cot.',
    thClass: 'hidden lg:table-cell', tdClass: 'hidden lg:table-cell text-ink-700 tabular-nums',
    cell: ({ quoteCount }) => quoteCount,
  },
  {
    key: 'containers', label: 'Cont.',
    thClass: 'hidden lg:table-cell', tdClass: 'hidden lg:table-cell text-ink-700 tabular-nums',
    cell: ({ containerCount }) => containerCount,
  },
  {
    key: 'updated', label: 'Actualizado',
    thClass: 'hidden xl:table-cell', tdClass: 'hidden xl:table-cell text-ink-400 whitespace-nowrap tabular-nums',
    cell: ({ o }) => formatDateTime(o.updatedAt),
  },
  {
    key: 'total', label: 'Total',
    thClass: 'text-right', tdClass: 'text-right font-semibold whitespace-nowrap tabular-nums',
    cell: ({ total }) => formatMoney(total, 'USD', { USD: 1 }),
  },
];

// Default visibility for the hideable columns — the set the table shipped with
// (number is always on). Persisted per-browser so a column choice sticks.
const ORDER_DEFAULT_COLS = {
  name: true, customer: true, status: true, quotes: true, containers: true, updated: true, total: true,
};
const ORDER_COLS_STORAGE_KEY = 'rs.orders.cols.v1';

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
  const { profileId, settings, isAdmin } = useApp();

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
      settings: viewerCompanySettings(settings, isAdmin),
    }),
    [orders, customers, allQuotes, allContainers, allLines, settings, isAdmin],
  );

  // Column visibility (Shopify "edit columns") — persisted per browser. The
  // table renders `cols` (number anchor + the toggled-on columns, in order);
  // the standalone menu gets the full ORDER_COLUMNS so hidden ones can return.
  const {
    visible: visibleCols, setVisible: setVisibleCols, reset: resetCols, cols,
  } = useColumns(ORDER_COLUMNS, ORDER_DEFAULT_COLS, ORDER_COLS_STORAGE_KEY);
  // Drag-to-resize widths (persisted) for the same visible columns.
  const {
    tableRef, tableStyle, thProps, ResizeHandle, reset: resetWidths,
  } = useColumnWidths(cols, 'rs.orders.widths.v1');

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
    // Capture the attached quotes BEFORE the delete: quotes.order_id is
    // `on delete set null`, so deleting the order nulls every linked quote's
    // orderId at the DB level — a by-orderId lookup afterwards finds nothing.
    // With the ids in hand, reconcile each freed quote (now order-less, so it
    // holds no stock) to add its LSG pieces back on Shopify.
    const freed = await db.quotes.where('orderId').equals(order.id).toArray();
    await db.orders.delete(order.id);
    invalidate();
    for (const q of freed) reconcileQuoteStock(q.id).catch(() => {});
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
          action={<button onClick={newOrder} className="btn-brand">Crear pedido</button>}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Pedidos"
        subtitle={`${orders.length} pedido${orders.length === 1 ? '' : 's'}`}
        actions={<button onClick={newOrder} className="btn-brand"><Plus size={14} /> Nuevo</button>}
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
      <div className="hidden md:block">
        {/* Standalone columns control (no search header on this page). */}
        <div className="hidden md:flex justify-end mb-2">
          <ColumnsMenu columns={ORDER_COLUMNS} visible={visibleCols} onChange={setVisibleCols} onReset={() => { resetCols(); resetWidths(); }} />
        </div>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
          <table ref={tableRef} style={tableStyle} className="table">
            <thead>
              <tr>
                {cols.map((col) => (
                  <th key={col.key} className={col.thClass || ''} {...thProps(col.key)}>
                    {col.label}
                    {ResizeHandle(col.key)}
                  </th>
                ))}
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <OrderRow
                  key={o.id}
                  o={o}
                  cols={cols}
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
        </div>
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
            <div className="text-sm font-medium tabular-nums">
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
        <button onClick={onDelete} className="btn-icon-danger -mr-1.5" title="Eliminar" aria-label="Eliminar">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function OrderRow({ o, cols, customerLabel, quoteCount, containerCount, total, onDelete }) {
  const stg = currentOrderStage(o);
  // One bag of row data; each column's pure `cell(ctx)` reads what it needs.
  const ctx = { o, stg, customerLabel, quoteCount, containerCount, total };
  return (
    <tr className="cursor-pointer transition-all hover:bg-ink-50/80 active:bg-ink-100" onClick={() => (window.location.hash = `#/orders/${o.id}`)}>
      {cols.map((col) => (
        <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
      ))}
      <td className="text-right w-12">
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="btn-icon-danger" title="Eliminar" aria-label="Eliminar">
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}
