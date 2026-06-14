import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigationType, useSearchParams } from 'react-router-dom';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import ListLoading from '../components/ListLoading.jsx';
import {
  Plus, FileText, Trash2, Truck, Archive, Check, Minus,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ScopeToggle, { SCOPE_MINE, SCOPE_TEAM } from '../components/ScopeToggle.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { useStickyState } from '../context/NavMemory.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { resolveQuotesList } from '../core/quote/views/lists.js';
import { resolveQuoteInvoiceStatus } from '../core/bridge/index.js';
import InvoiceChip from '../components/InvoiceChip.jsx';
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
      className="chip bg-amber-100 text-amber-700 whitespace-nowrap"
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
      className="chip shrink-0 bg-ink-100 text-ink-500"
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
 * Desktop table columns (Shopify-orders-style customizable list). ONE ordered
 * definition drives both the table render (`cell`) and the Columns menu
 * (`label` / `canHide`). `number` is the fixed identity anchor (`canHide:
 * false`) — it's never hidden and isn't offered in the menu; everything else
 * the seller can toggle. Each `cell` is a pure render off the per-row `ctx`
 * the row assembles, so adding a column is a one-entry edit here.
 */
const QUOTE_COLUMNS = [
  {
    key: 'number', label: 'Número', canHide: false,
    tdClass: 'font-medium tabular-nums whitespace-nowrap',
    cell: ({ qu }) => `#${qu.number || '—'}`,
  },
  {
    key: 'client', label: 'Cliente',
    tdClass: 'text-ink-700',
    cell: ({ client }) => (
      <div className="flex items-center gap-1 min-w-0 max-w-[180px]" title={client?.name || ''}>
        <span className="truncate">{client?.name || '—'}</span>
        {client?.isProfessional && <ProfessionalTag />}
      </div>
    ),
  },
  {
    key: 'creator', label: 'Vendedor',
    tdClass: 'text-ink-500',
    cell: ({ creatorLabel }) => (
      <span className="block truncate max-w-[150px]" title={creatorLabel}>{creatorLabel || '—'}</span>
    ),
  },
  {
    key: 'status', label: 'Estado',
    cell: ({ qu }) => (
      <div className="flex items-center gap-1.5">
        <StatusPill {...quoteStagePill(currentQuoteStage(qu))} />
        <TradeFlag quote={qu} />
      </div>
    ),
  },
  {
    key: 'invoice', label: 'Factura',
    cell: ({ invoice }) => (invoice ? <InvoiceChip invoice={invoice} /> : <span className="text-ink-300">—</span>),
  },
  {
    key: 'updated', label: 'Actualizada',
    tdClass: 'text-ink-400 tabular-nums whitespace-nowrap',
    cell: ({ qu }) => formatDateTime(qu.updatedAt),
  },
  {
    key: 'created', label: 'Creada',
    tdClass: 'text-ink-400 tabular-nums whitespace-nowrap',
    cell: ({ qu }) => formatDateTime(qu.createdAt),
  },
  {
    key: 'total', label: 'Total', align: 'right',
    thClass: 'text-right', tdClass: 'text-right font-semibold tabular-nums whitespace-nowrap',
    cell: ({ qu, total, rates }) => formatMoney(total, qu.currencyCode || 'USD', rates),
  },
];

// Default visibility for the hideable columns — the set the table shipped with
// (number is always on). Persisted per-browser so a seller's column choice
// sticks across sessions; bumped suffix (_v1) lets a future column set reset.
const DEFAULT_VISIBLE_COLS = {
  client: true, creator: false, status: true, invoice: true, updated: true, created: false, total: true,
};
const COLS_STORAGE_KEY = 'rs.quotes.cols.v1';

function loadVisibleCols() {
  try {
    const raw = localStorage.getItem(COLS_STORAGE_KEY);
    if (raw) return { ...DEFAULT_VISIBLE_COLS, ...JSON.parse(raw) };
  } catch { /* storage unavailable — fall back to defaults */ }
  return DEFAULT_VISIBLE_COLS;
}

/**
 * Tri-state selection box (Shopify's row / select-all checkbox). A real
 * checkbox can't render the "some but not all" dash with our theming, so this
 * is a `role="checkbox"` button reporting `aria-checked="mixed"` for the
 * indeterminate header state. The row's open-on-click is suppressed by the
 * enclosing cell (it stops propagation), so ticking a box never opens a quote.
 */
function SelectBox({ checked, indeterminate = false, onChange, label }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      onClick={onChange}
      className={`flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-colors ${
        checked || indeterminate
          ? 'border-brand-500 bg-brand-500 text-white'
          : 'border-ink-300 bg-surface hover:border-ink-400'
      }`}
    >
      {indeterminate ? <Minus size={13} /> : (checked ? <Check size={13} /> : null)}
    </button>
  );
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
  const navType = useNavigationType(); // 'PUSH' | 'REPLACE' | 'POP' (back/fwd/load)
  // scope / search / status-tab / vendedor filter / sort are sticky
  // (useStickyState): leave Cotizaciones and Back restores the exact view you
  // left. A `?scope=` / `?status=` deep-link (dashboard cards) still wins — see
  // the override effect below — so those links always land pre-filtered.
  const [scope, setScope] = useStickyState('scope', () => {
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
  // Accounting → CRM, through the bridge: which quotes are already invoiced
  // (NCF stamp on the row). Read-only; the list never sees the asiento.
  const postings = useLiveQuery(
    () => db.salesPostings.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const invoiceByQuoteId = useMemo(() => resolveQuoteInvoiceStatus(postings), [postings]);

  // Search header query state. The status dimension is the primary tab
  // strip ('all' = Todas); secondary filters (currently just vendedor)
  // live in `activeFilters` as {key: value}; sort defaults to most-recent.
  const [q, setQ] = useStickyState('q', '');
  // Initialize the status tab from `?status=` so deep-links (dashboard
  // "Ver enviadas / aceptadas / borradores") land pre-filtered.
  const [tab, setTab] = useStickyState('tab', () => {
    const s = searchParams.get('status');
    return s && VALID_TABS.has(s) ? s : 'all';
  });
  const [filters, setFilters] = useStickyState('filters', {}); // { creator: <profileId> }
  const [sort, setSort] = useStickyState('sort', { key: 'recent', dir: 'desc' });

  // Deep-link override: a `?scope=` / `?status=` param (dashboard cards) must
  // win over the sticky remembered view, so the link lands pre-filtered even if
  // you'd left Cotizaciones on a different scope/pill. Only on a genuine arrival
  // (PUSH/REPLACE) — on a POP (Back/Forward, or initial load) we trust the
  // sticky store instead, so going Back to a page whose URL still carries an old
  // `?status=` doesn't clobber the view you'd switched to (the first-load case is
  // already covered by the sticky lazy-init reading the param). Applied once per
  // distinct param set so it doesn't fight later manual changes.
  const appliedDeepLink = useRef('');
  useEffect(() => {
    if (navType === 'POP') return; // Back/Forward/load → respect the sticky view
    const sScope = searchParams.get('scope');
    const sStatus = searchParams.get('status');
    if (!sScope && !sStatus) return; // no deep-link → respect the sticky view
    const sig = `${sScope || ''}|${sStatus || ''}`;
    if (appliedDeepLink.current === sig) return;
    appliedDeepLink.current = sig;
    if (sScope === SCOPE_TEAM || sScope === SCOPE_MINE) setScope(sScope);
    if (sStatus && VALID_TABS.has(sStatus)) setTab(sStatus);
  }, [navType, searchParams, setScope, setTab]);

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

  // Column visibility (Shopify "edit columns") — persisted per browser. The
  // table renders `cols` (number anchor + the toggled-on columns, in order);
  // the Columns menu gets the full QUOTE_COLUMNS so hidden ones can return.
  const [visibleCols, setVisibleCols] = useState(loadVisibleCols);
  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(visibleCols)); } catch { /* ignore */ }
  }, [visibleCols]);
  const cols = useMemo(
    () => QUOTE_COLUMNS.filter((c) => c.canHide === false || visibleCols[c.key]),
    [visibleCols],
  );
  const colSpan = cols.length + 2; // checkbox + data columns + actions

  // Bulk selection (Shopify row checkboxes + contextual action bar). Desktop
  // table only. Selection is pruned to the CURRENT filter so a bulk action can
  // only ever touch rows the seller can actually see — flip a tab or search and
  // anything that scrolled out drops out of the selection.
  const [selected, setSelected] = useState(() => new Set());
  const visibleIdKey = filtered.map((qu) => qu.id).join(',');
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filtered.map((qu) => qu.id));
      let changed = false;
      const next = new Set();
      for (const id of prev) { if (visible.has(id)) next.add(id); else changed = true; }
      return changed ? next : prev;
    });
    // visibleIdKey is the stable signature of `filtered`; depend on it alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdKey]);

  const allSelected = filtered.length > 0 && filtered.every((qu) => selected.has(qu.id));
  const someSelected = selected.size > 0 && !allSelected;
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map((qu) => qu.id)));
  const clearSel = () => setSelected(new Set());

  // Bulk archive mirrors the manual stepper write (status + archivedAt), so a
  // bulk-archive and a hand-archive are indistinguishable — "Volver" un-archives
  // either the same way. Reversible, so no confirm.
  async function bulkArchive() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const now = Date.now();
    await Promise.all(ids.map((id) => db.quotes.update(id, { status: 'archived', archivedAt: now })));
    clearSel();
  }
  // Bulk delete mirrors the per-row delete (cascade the quote's lines first).
  // Destructive → confirm with the count.
  async function bulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`¿Eliminar ${ids.length} cotización${ids.length === 1 ? '' : 'es'}? Esta acción no se puede deshacer.`)) return;
    for (const id of ids) {
      const qlines = await db.quoteLines.where('quoteId').equals(id).toArray();
      await db.quoteLines.bulkDelete(qlines.map((l) => l.id));
      await db.quotes.delete(id);
    }
    clearSel();
  }

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
          action={<Link to="/quotes/new" className="btn-brand">Nueva cotización</Link>}
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
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {meId && <ScopeToggle scope={scope} onChange={setScope} />}
            <Link to="/quotes/new" className="btn-brand"><Plus size={14} /> Nueva cotización</Link>
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
        columns={QUOTE_COLUMNS}
        visibleColumns={visibleCols}
        onColumnsChange={setVisibleCols}
        onColumnsReset={() => setVisibleCols(DEFAULT_VISIBLE_COLS)}
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
            invoice={invoiceByQuoteId.get(qu.id)}
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

      {/* Contextual bulk-action bar (Shopify) — appears only with a selection,
          desktop table only. Archivar is reversible (no confirm); Eliminar
          confirms with the count. */}
      {selected.size > 0 && (
        <div className="hidden md:flex items-center justify-between gap-3 mb-3 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="tabular-nums font-semibold text-brand-700">{selected.size}</span>
            <span className="text-ink-600">seleccionada{selected.size === 1 ? '' : 's'}</span>
            <button
              type="button"
              onClick={clearSel}
              className="text-xs text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline"
            >
              Limpiar
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={bulkArchive} className="btn-secondary">
              <Archive size={14} /> Archivar
            </button>
            <button
              type="button"
              onClick={bulkDelete}
              className="btn-secondary text-red-600 hover:border-red-300 hover:text-red-700"
            >
              <Trash2 size={14} /> Eliminar
            </button>
          </div>
        </div>
      )}

      {/* Desktop: table. Columns are user-customizable (Columnas menu) so it
          scrolls horizontally when many are on, rather than crushing cells. */}
      <div className="hidden md:block card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="w-10">
                  <SelectBox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={toggleAll}
                    label="Seleccionar todas las cotizaciones"
                  />
                </th>
                {cols.map((col) => (
                  <th key={col.key} className={col.thClass || ''}>{col.label}</th>
                ))}
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {orderGroups.map((u) => (u.type === 'group' ? (
                <Fragment key={`order-${u.order.id}`}>
                  <tr className="bg-ink-50/80">
                    <td colSpan={colSpan} className="border-l-2 border-t border-ink-200 px-3 py-2">
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
                      cols={cols}
                      selected={selected.has(qu.id)}
                      onToggleSelect={() => toggleOne(qu.id)}
                      client={clientByQuoteId.get(qu.id)}
                      creator={profileById.get(qu.createdByUserId)}
                      total={totalByQuoteId.get(qu.id) || 0}
                      rates={displayRatesFor(qu, settings)}
                      invoice={invoiceByQuoteId.get(qu.id)}
                    />
                  ))}
                  {/* Closing floor — left bar + bottom border seal the group so
                      the rows beneath it clearly aren't part of it. */}
                  <tr aria-hidden="true" className="bg-ink-50/40">
                    <td colSpan={colSpan} className="h-1.5 p-0 border-l-2 border-b-2 border-ink-300" />
                  </tr>
                </Fragment>
              ) : (
                <QuoteRow
                  key={u.quote.id}
                  qu={u.quote}
                  cols={cols}
                  selected={selected.has(u.quote.id)}
                  onToggleSelect={() => toggleOne(u.quote.id)}
                  client={clientByQuoteId.get(u.quote.id)}
                  creator={profileById.get(u.quote.createdByUserId)}
                  total={totalByQuoteId.get(u.quote.id) || 0}
                  rates={displayRatesFor(u.quote, settings)}
                  invoice={invoiceByQuoteId.get(u.quote.id)}
                />
              )))}
            </tbody>
          </table>
        </div>
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

function QuoteCard({ qu, client, creator, order, tracking, total, rates, invoice }) {
  const { del } = useQuoteOps(qu);
  const creatorLabel = creatorDisplay(creator);

  return (
    <div className="card card-interactive p-3 transition-all hover:shadow-md hover:-translate-y-0.5">
      <Link to={`/quotes/${qu.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium tabular-nums">#{qu.number || '—'}</div>
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-xs text-ink-500 truncate">{client?.name || 'Sin cliente'}</span>
              {client?.isProfessional && <ProfessionalTag />}
            </div>
            {creatorLabel && (
              <div className="text-[11px] text-ink-400 truncate">por {creatorLabel}</div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-semibold tabular-nums">{formatMoney(total, qu.currencyCode || 'USD', rates)}</div>
            <div className="text-[10px] text-ink-400 tabular-nums">{formatDateTime(qu.updatedAt)}</div>
          </div>
        </div>
      </Link>
      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-ink-100">
        <StatusPill {...quoteStagePill(currentQuoteStage(qu))} />
        <InvoiceChip invoice={invoice} />
        <TradeFlag quote={qu} />
        <div className="flex-1 min-w-0">
          <OrderIndicator order={order} />
        </div>
        <button onClick={del} className="btn-icon-danger -mr-1.5" title="Eliminar" aria-label="Eliminar">
          <Trash2 size={16} />
        </button>
      </div>
      {tracking?.length > 0 && (
        <ShipmentTracking containers={tracking} collapsible className="mt-2 pt-2 border-t border-ink-100" />
      )}
    </div>
  );
}

function QuoteRow({ qu, client, creator, total, rates, grouped = false, invoice, cols, selected = false, onToggleSelect }) {
  const { del } = useQuoteOps(qu);
  const creatorLabel = creatorDisplay(creator);
  // One bag of row data; each column's pure `cell(ctx)` reads what it needs.
  const ctx = { qu, client, creatorLabel, total, rates, invoice };

  return (
    <tr
      className={`cursor-pointer transition-colors hover:bg-ink-50/80 active:bg-ink-100 ${
        selected ? 'bg-brand-50/60' : grouped ? 'bg-ink-50/40' : ''
      }`}
      onClick={() => (window.location.hash = `#/quotes/${qu.id}`)}
    >
      {/* Selection cell — stop the click here so ticking the box never opens
          the quote (the rest of the row still navigates). */}
      <td
        className={grouped ? 'border-l-2 border-ink-300 pl-4' : ''}
        onClick={(e) => e.stopPropagation()}
      >
        <SelectBox
          checked={selected}
          onChange={onToggleSelect}
          label={`Seleccionar cotización #${qu.number || ''}`}
        />
      </td>
      {cols.map((col) => (
        <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
      ))}
      <td className="text-right w-12">
        <button onClick={del} className="btn-icon-danger" title="Eliminar" aria-label="Eliminar">
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
