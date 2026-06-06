import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import ListLoading from '../components/ListLoading.jsx';
import { Plus, FileText, Trash2, Truck } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ScopeToggle, { SCOPE_MINE, SCOPE_TEAM } from '../components/ScopeToggle.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { resolveQuotesList } from '../core/quote/views/lists.js';
import ShipmentTracking from '../components/ShipmentTracking.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { quoteStagePill } from '../lib/statusPill.js';
import { displayRatesFor } from '../lib/exchangeRate.js';
import { currentQuoteStage } from '../lib/quoteStages.js';
import { isTradeDiscount } from '../lib/commissions.js';

/**
 * Small amber flag for quotes settled as a decorator trade discount —
 * accounting bills the decorator (not the client), no commission. The
 * common 'commission' modality (and quotes with no professional) get no
 * marker, so the flag draws the eye only to the exceptional path.
 */
function TradeFlag({ quote }) {
  if (!quote.professionalId || !isTradeDiscount(quote)) return null;
  return (
    <span
      className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 whitespace-nowrap"
      title="Trade discount: facturar al decorador (sin comisión)"
    >
      Trade
    </span>
  );
}

/**
 * Marks the "Cliente" value as the referring PROFESSIONAL — shown when a quote
 * has no customer assigned, so the row still names who the work is for without
 * the value being mistaken for an actual client.
 */
function ProfessionalTag() {
  return (
    <span
      className="shrink-0 inline-flex items-center rounded-full bg-ink-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-500"
      title="Profesional · sin cliente asignado"
    >
      Profesional
    </span>
  );
}

// Tab keys the list understands. A `?status=` deep-link (e.g. from the
// dashboard's "Ver aceptadas") is honored only if it names one of these;
// anything else falls back to "Todas".
const VALID_TABS = new Set([
  'all', 'draft', 'sent', 'accepted', 'deposito_recibido', 'declined', 'archived',
]);

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
  const { profileId, profiles, settings, currentProfile } = useApp();
  // Mías / Equipo scope — defaults to the signed-in seller's own quotes
  // (same toggle the home uses). Falls back to team when the current user
  // isn't known yet.
  const meId = currentProfile?.id || null;
  // Honor a `?scope=` deep-link (the dashboard carries its Mías/Equipo
  // state across when you tap a status card) — else default to "mine".
  const [searchParams] = useSearchParams();
  const [scope, setScope] = useState(() => {
    const s = searchParams.get('scope');
    return s === SCOPE_TEAM || s === SCOPE_MINE ? s : SCOPE_MINE;
  });
  const effectiveScope = meId ? scope : SCOPE_TEAM;
  // Quotes is the main list. Gate the "Sin cotizaciones" empty state on
  // `loaded` so we don't show a misleading "no data" message during the
  // first fetch — that flicker is the bug we're killing.
  const { data: quotes, loaded } = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').reverse().sortBy('updatedAt'),
    [profileId],
    []
  );
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    []
  );
  // Professionals: the row falls back to the referring professional as the
  // "client" when a quote has no customer assigned, so a clientless quote still
  // names who the work is for.
  const professionals = useLiveQuery(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
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
  // Containers loaded once (small table) so a suitable quote row can offer
  // shipment tracking without an N-row fan-out of per-order queries.
  const containers = useLiveQuery(
    () => db.containers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  // Search header query state. The status dimension is the primary tab
  // strip ('all' = Todas); secondary filters (currently just vendedor)
  // live in `activeFilters` as {key: value}; sort defaults to most-recent.
  const [q, setQ] = useState('');
  // Initialize the status tab from `?status=` so deep-links (dashboard
  // "Ver enviadas / aceptadas / borradores") land pre-filtered.
  const [tab, setTab] = useState(() => {
    const s = searchParams.get('status');
    return s && VALID_TABS.has(s) ? s : 'all';
  });
  const [filters, setFilters] = useState({}); // { creator: <profileId> }
  const [sort, setSort] = useState({ key: 'recent', dir: 'desc' });

  const sortOptions = [
    { key: 'recent', label: 'Más reciente' },
    { key: 'amount', label: 'Monto' },
    { key: 'customer', label: 'Cliente' },
  ];

  // Everything the list renders — the lookups, tab counts, vendedor filter,
  // sorted result rows, the per-order desktop grouping and the per-order
  // tracker assignment — is a pure projection of the raw rows plus the
  // interactive state (scope / search / tab / filters / sort). The page keeps
  // the state in React and derives nothing itself. Memoized on exactly the
  // inputs the old per-derivation useMemos depended on so render behavior is
  // unchanged.
  const {
    scopedCount, tabs, creatorFilter, rows: filtered, orderGroups,
    trackingByQuoteId, totalByQuoteId, clientByQuoteId, profileById,
    ordersById, trackableByOrderId,
  } = useMemo(
    () => resolveQuotesList({
      quotes, customers, professionals, profiles, orders, containers, lines: allLines,
      scope, meId, q, tab, filters, sort,
    }),
    [quotes, customers, professionals, profiles, orders, containers, allLines, scope, meId, q, tab, filters, sort],
  );

  if (!loaded) {
    return (
      <>
        <PageHeader title="Cotizaciones" />
        <div className="card overflow-hidden"><ListLoading rows={6} /></div>
      </>
    );
  }
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
        subtitle={`${scopedCount} ${scopedCount === 1 ? 'cotización' : 'cotizaciones'}`}
        actions={
          <div className="flex items-center gap-2">
            {meId && <ScopeToggle scope={scope} onChange={setScope} />}
            <Link to="/quotes/new" className="btn-primary"><Plus size={14} /> Nueva cotización</Link>
          </div>
        }
      />

      <ListSearchHeader
        searchValue={q}
        onSearchChange={setQ}
        searchPlaceholder="Buscar por número o cliente…"
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        filters={effectiveScope === SCOPE_TEAM ? [creatorFilter] : []}
        activeFilters={filters}
        onFiltersChange={setFilters}
        sortOptions={sortOptions}
        sort={sort}
        onSortChange={setSort}
        resultCount={filtered.length}
        resultNoun={['cotización', 'cotizaciones']}
      />

      {/* Mobile: cards */}
      <div className="md:hidden space-y-2">
        {filtered.map((qu) => (
          <QuoteCard
            key={qu.id}
            qu={qu}
            client={clientByQuoteId.get(qu.id)}
            creator={profileById.get(qu.createdByUserId)}
            order={ordersById.get(qu.orderId)}
            tracking={trackingByQuoteId.get(qu.id)}
            total={totalByQuoteId.get(qu.id) || 0}
            rates={displayRatesFor(qu, settings)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="card card-pad flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-100 ring-1 ring-inset ring-black/5">
              <FileText size={20} className="text-ink-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-ink-600">Sin coincidencias</p>
              <p className="mt-0.5 text-xs text-ink-400">Intenta cambiar el filtro o el término de búsqueda.</p>
            </div>
          </div>
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
              <th className="hidden xl:table-cell">Creada por</th>
              <th>Estado</th>
              <th className="hidden lg:table-cell">Actualizada</th>
              <th className="text-right">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orderGroups.map((u) => (u.type === 'group' ? (
              <Fragment key={`order-${u.order.id}`}>
                <tr className="bg-ink-50/80">
                  <td colSpan={7} className="border-l-2 border-t border-ink-200 px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`/orders/${u.order.id}`}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-700 hover:text-brand-600 transition-colors"
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-50 ring-1 ring-inset ring-brand-200/60">
                          <Truck size={11} className="text-brand-600" />
                        </span>
                        Pedido #{u.order.number ?? u.order.id.slice(-4)}
                        {u.order.name ? <span className="font-normal text-ink-400">· {u.order.name}</span> : null}
                      </Link>
                      <span className="text-[11px] text-ink-400">
                        {u.quotes.length} cotización{u.quotes.length === 1 ? '' : 'es'}
                      </span>
                    </div>
                    {/* Full cell width below the header line, so the opened
                        tracker can use the whole row (not a squished column). */}
                    {trackableByOrderId.get(u.order.id)?.length > 0 && (
                      <ShipmentTracking containers={trackableByOrderId.get(u.order.id)} collapsible className="mt-2" />
                    )}
                  </td>
                </tr>
                {u.quotes.map((qu) => (
                  <QuoteRow
                    key={qu.id}
                    qu={qu}
                    grouped
                    client={clientByQuoteId.get(qu.id)}
                    creator={profileById.get(qu.createdByUserId)}
                    total={totalByQuoteId.get(qu.id) || 0}
                    rates={displayRatesFor(qu, settings)}
                  />
                ))}
                {/* Closing floor — left bar + bottom border seal the group so
                    the rows beneath it clearly aren't part of it. */}
                <tr aria-hidden="true" className="bg-ink-50/40">
                  <td colSpan={7} className="h-1.5 p-0 border-l-2 border-b-2 border-ink-300" />
                </tr>
              </Fragment>
            ) : (
              <QuoteRow
                key={u.quote.id}
                qu={u.quote}
                client={clientByQuoteId.get(u.quote.id)}
                creator={profileById.get(u.quote.createdByUserId)}
                total={totalByQuoteId.get(u.quote.id) || 0}
                rates={displayRatesFor(u.quote, settings)}
              />
            )))}
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

function QuoteCard({ qu, client, creator, order, tracking, total, rates }) {
  const { del } = useQuoteOps(qu);
  const creatorLabel = creatorDisplay(creator);

  return (
    <div className="card card-interactive p-3 transition-all hover:shadow-md hover:-translate-y-0.5">
      <Link to={`/quotes/${qu.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold tabular-nums">#{qu.number || '—'}</div>
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-xs text-ink-500 truncate">{client?.name || 'Sin cliente'}</span>
              {client?.isProfessional && <ProfessionalTag />}
            </div>
            {creatorLabel && (
              <div className="text-[11px] text-ink-400 truncate">por {creatorLabel}</div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-medium tabular-nums">{formatMoney(total, qu.currencyCode || 'USD', rates)}</div>
            <div className="text-[10px] text-ink-400 tabular-nums">{formatDateTime(qu.updatedAt)}</div>
          </div>
        </div>
      </Link>
      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-ink-100">
        <StatusPill {...quoteStagePill(currentQuoteStage(qu))} />
        <TradeFlag quote={qu} />
        <div className="flex-1 min-w-0">
          <OrderIndicator order={order} />
        </div>
        <button onClick={del} className="text-ink-300 hover:text-red-500 p-2 transition-colors min-h-11 coarse:min-h-11 active:scale-95" aria-label="Eliminar">
          <Trash2 size={16} />
        </button>
      </div>
      {tracking?.length > 0 && (
        <ShipmentTracking containers={tracking} collapsible className="mt-2 pt-2 border-t border-ink-100" />
      )}
    </div>
  );
}

function QuoteRow({ qu, client, creator, total, rates, grouped = false }) {
  const { del } = useQuoteOps(qu);
  const creatorLabel = creatorDisplay(creator);

  return (
    <tr
      className={`cursor-pointer transition-all hover:bg-ink-50/80 hover:shadow-xs active:bg-ink-100 ${grouped ? 'bg-ink-50/40' : ''}`}
      onClick={() => (window.location.hash = `#/quotes/${qu.id}`)}
    >
      <td className={`font-medium tabular-nums whitespace-nowrap ${grouped ? 'border-l-2 border-ink-300 pl-5' : ''}`}>
        #{qu.number || '—'}
      </td>
      <td className="text-ink-700 max-w-[160px]" title={client?.name || ''}>
        <div className="flex items-center gap-1 min-w-0">
          <span className="truncate">{client?.name || '—'}</span>
          {client?.isProfessional && <ProfessionalTag />}
        </div>
      </td>
      <td className="hidden xl:table-cell text-ink-500 truncate max-w-[140px]" title={creatorLabel}>
        {creatorLabel || '—'}
      </td>
      <td>
        <div className="flex items-center gap-1.5">
          <StatusPill {...quoteStagePill(currentQuoteStage(qu))} />
          <TradeFlag quote={qu} />
        </div>
      </td>
      <td className="hidden lg:table-cell text-ink-400 tabular-nums whitespace-nowrap">{formatDateTime(qu.updatedAt)}</td>
      <td className="text-right font-medium tabular-nums whitespace-nowrap">{formatMoney(total, qu.currencyCode || 'USD', rates)}</td>
      <td className="text-right w-12">
        <button onClick={del} className="text-ink-300 hover:text-red-500 transition-colors active:scale-95 p-1.5 rounded" title="Eliminar">
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

// Shared display rule for the quote-creator field. Returns the
// creator's stored name if available, falls back to the email prefix,
// or "—" if nothing on file. Empty string means "render nothing"
// (the call site uses truthy checks to decide whether to render the
// "Creada por …" line at all).
function creatorDisplay(creator) {
  if (!creator) return '';
  if (creator.name && creator.name.trim()) return creator.name.trim();
  if (creator.email) return creator.email.split('@')[0];
  return '';
}
