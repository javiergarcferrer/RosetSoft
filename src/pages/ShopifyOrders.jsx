import { useEffect, useMemo, useState } from 'react';
import { ShoppingBag, Loader2, Check, RefreshCw, Search } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ListLoading from '../components/ListLoading.jsx';
import { userMessageFor } from '../lib/errorMessages.js';
import { formatDate } from '../lib/format.js';
import { listShopifyOrders, fulfillShopifyOrder } from '../lib/shopifySync.js';
import { resolveOrdersList } from '../core/shopify/index.js';

const FILTERS = [
  { id: 'all', label: 'Todos' },
  { id: 'unfulfilled', label: 'Por preparar' },
  { id: 'fulfilled', label: 'Preparados' },
];

const STATE_LABEL = { unfulfilled: 'Por preparar', partial: 'Parcial', fulfilled: 'Preparado' };
const STATE_PILL = { unfulfilled: 'status-pill-pending', partial: 'status-pill-sent', fulfilled: 'status-pill-accepted' };

/**
 * Pedidos Shopify — el centro de control de la tienda Alcover: lee los pedidos
 * recientes y permite marcar uno como preparado (fulfillment) sin salir de
 * ALCOVER. La proyección la hace resolveOrdersList; esta página solo busca,
 * filtra en memoria y dispara la acción.
 */
export default function ShopifyOrders() {
  const [orders, setOrders] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [fulfilling, setFulfilling] = useState('');

  async function load() {
    setRefreshing(true);
    setErr('');
    try {
      const res = await listShopifyOrders({ limit: 50 });
      if (res?.configured === false) { setNotConfigured(true); setOrders([]); return; }
      setNotConfigured(false);
      if (res?.ok === false) { setErr(res.error || 'No se pudieron cargar los pedidos.'); return; }
      setOrders(Array.isArray(res?.orders) ? res.orders : []);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  }

  useEffect(() => { load(); }, []);

  const { rows, stats } = useMemo(() => resolveOrdersList(orders, { filter, search }), [orders, filter, search]);

  async function markPrepared(row) {
    if (!row.fulfillmentOrderId) return;
    setFulfilling(row.key);
    setErr('');
    try {
      const res = await fulfillShopifyOrder({ fulfillmentOrderId: row.fulfillmentOrderId });
      if (res?.ok === false) { setErr(res.error || 'Shopify no pudo marcar el pedido como preparado.'); return; }
      await load();
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setFulfilling('');
    }
  }

  return (
    <div>
      <PageHeader
        title="Pedidos Shopify"
        subtitle={loaded && !notConfigured ? `${stats.total} pedidos · ${stats.unfulfilled} por preparar · ${stats.fulfilled} preparados` : ' '}
        actions={(
          <button type="button" onClick={load} disabled={refreshing} className="btn-secondary">
            {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Actualizar
          </button>
        )}
      />

      {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}

      {!loaded ? (
        <ListLoading />
      ) : notConfigured ? (
        <EmptyState icon={ShoppingBag} title="Shopify no conectado" description="Conecta la tienda Alcover en Configuración para ver y preparar pedidos." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex gap-1">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" onClick={() => setFilter(f.id)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${filter === f.id ? 'bg-ink-900 text-surface' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'}`}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative ml-auto">
              <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar pedido o cliente"
                className="input pl-8 w-56" />
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState icon={ShoppingBag} title="Sin pedidos" description="No hay pedidos que coincidan con el filtro." />
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="table min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th>Cliente</th>
                      <th className="whitespace-nowrap hidden sm:table-cell">Fecha</th>
                      <th className="text-right whitespace-nowrap">Artículos</th>
                      <th>Estado</th>
                      <th className="text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <td className="font-medium whitespace-nowrap">{row.number}</td>
                        <td className="min-w-0"><div className="truncate">{row.customer || <span className="text-ink-400">—</span>}</div></td>
                        <td className="text-ink-500 whitespace-nowrap hidden sm:table-cell">{row.createdAt ? formatDate(row.createdAt) : '—'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{row.units} <span className="text-ink-400 text-xs">({row.lines})</span></td>
                        <td>
                          <span className={`status-pill ${STATE_PILL[row.state]}`}>{STATE_LABEL[row.state]}</span>
                        </td>
                        <td className="text-right">
                          {row.canFulfill ? (
                            <button type="button" onClick={() => markPrepared(row)} disabled={fulfilling === row.key}
                              className="btn-secondary">
                              {fulfilling === row.key ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                              <span className="hidden sm:inline">Marcar como preparado</span><span className="sm:hidden">Preparar</span>
                            </button>
                          ) : (
                            <span className="text-ink-400 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
