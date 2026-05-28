import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import ListLoading from '../components/ListLoading.jsx';
import { Plus, FileText, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ScopeToggle, { SCOPE_MINE, SCOPE_TEAM } from '../components/ScopeToggle.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { computeTotals, lineForTotals } from '../lib/pricing.js';
import { isPricedLine } from '../lib/constants.js';
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
  const orders = useLiveQuery(
    () => db.orders.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    []
  );
  // Batch fetch lines once → derive per-quote totals in O(N+M) instead of
  // N round-trips for N visible quotes. Cheaper for the dashboard's six
  // recent quotes and an order of magnitude cheaper for the full list page.
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);

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

  const customerById = useMemo(() => {
    const m = new Map();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  // Profiles include the shared 'team' settings row alongside real
  // users; the lookup is keyed by auth.uid() so we hit only the
  // matching employee on each quote.createdByUserId reference.
  const profileById = useMemo(() => {
    const m = new Map();
    for (const p of profiles) m.set(p.id, p);
    return m;
  }, [profiles]);

  const ordersById = useMemo(() => {
    const m = new Map();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

  // Per-quote grand total. Previously inline `qty * unitPrice`, which
  // (a) ignored compound lines (their own qty/unitPrice are 0 by
  // design — the math lives in `components`) so a compound quote showed
  // $0 in the list, and (b) ignored every adjustment: line discount,
  // quote-level margin / discount, ITBIS, shipping. Routes the same way
  // Dashboard / CustomerDetail / ProfessionalDetail do — single source
  // of truth for the figure the dealer scans down this column.
  const totalByQuoteId = useMemo(() => {
    const linesByQuote = new Map();
    for (const l of allLines) {
      if (!linesByQuote.has(l.quoteId)) linesByQuote.set(l.quoteId, []);
      linesByQuote.get(l.quoteId).push(l);
    }
    const m = new Map();
    for (const qu of quotes) {
      const rows = (linesByQuote.get(qu.id) || [])
        .filter(isPricedLine)
        .map(lineForTotals);
      m.set(qu.id, computeTotals(rows, qu).grandTotal);
    }
    return m;
  }, [allLines, quotes]);

  // Apply the Mías / Equipo scope FIRST — every downstream view (tab
  // counts, the vendedor filter options, the result list) reads from this
  // so the whole page reflects the toggle, not just the rows.
  const scopedQuotes = useMemo(
    () => (effectiveScope === SCOPE_TEAM
      ? quotes
      : quotes.filter((qu) => qu.createdByUserId === meId)),
    [quotes, effectiveScope, meId],
  );

  // Tabs for the primary status dimension. Counts are computed off the
  // scoped list so each tab shows "how many would I see if I tapped this"
  // within the current scope, independent of the search needle.
  const tabs = useMemo(() => {
    // Count by the derived lifecycle stage (currentQuoteStage), so a quote
    // with a deposit shows under "Depósito recibido" — same dimension the
    // status pill and the order page use.
    const counts = { draft: 0, sent: 0, accepted: 0, deposito_recibido: 0, declined: 0, archived: 0 };
    for (const qu of scopedQuotes) {
      const stage = currentQuoteStage(qu);
      if (stage in counts) counts[stage] += 1;
    }
    return [
      { key: 'all', label: 'Todas', count: scopedQuotes.length },
      { key: 'draft', label: 'Borrador', count: counts.draft, pillCls: quoteStagePill('draft').cls },
      { key: 'sent', label: 'Enviada', count: counts.sent, pillCls: quoteStagePill('sent').cls },
      { key: 'accepted', label: 'Aceptada', count: counts.accepted, pillCls: quoteStagePill('accepted').cls },
      { key: 'deposito_recibido', label: 'Depósito recibido', count: counts.deposito_recibido, pillCls: quoteStagePill('deposito_recibido').cls },
      { key: 'declined', label: 'Rechazada', count: counts.declined, pillCls: quoteStagePill('declined').cls },
      { key: 'archived', label: 'Archivada', count: counts.archived, pillCls: quoteStagePill('archived').cls },
    ];
  }, [scopedQuotes]);

  // Secondary filter: vendedor (the quote's creator). Options are the
  // distinct creators actually present on this team's quotes, so the
  // dropdown never lists someone who's authored nothing.
  const creatorFilter = useMemo(() => {
    const seen = new Map();
    for (const qu of quotes) {
      const id = qu.createdByUserId;
      if (!id || seen.has(id)) continue;
      const label = creatorDisplay(profileById.get(id));
      if (label) seen.set(id, label);
    }
    const options = [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      key: 'creator',
      label: 'Vendedor',
      type: 'select',
      placeholder: 'Todos',
      options,
    };
  }, [quotes, profileById]);

  const sortOptions = [
    { key: 'recent', label: 'Más reciente' },
    { key: 'amount', label: 'Monto' },
    { key: 'customer', label: 'Cliente' },
  ];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // The vendedor filter only applies in team scope — under "Mías" you're
    // already scoped to yourself, so it's hidden and ignored.
    const creator = effectiveScope === SCOPE_TEAM ? filters.creator : null;
    const rows = scopedQuotes
      .filter((qu) => (tab === 'all' ? true : currentQuoteStage(qu) === tab))
      .filter((qu) => (creator ? qu.createdByUserId === creator : true))
      .filter((qu) => {
        if (!needle) return true;
        const cust = customerById.get(qu.customerId);
        return (
          (qu.number || '').toString().includes(needle) ||
          (cust?.name || '').toLowerCase().includes(needle) ||
          (cust?.company || '').toLowerCase().includes(needle)
        );
      });

    // Sort. 'recent' rides updatedAt (the query already comes pre-sorted
    // most-recent-first, but re-sorting here keeps the direction toggle
    // honest); 'amount' uses the derived grand total; 'customer' the
    // customer display name. Direction multiplier flips asc/desc.
    const mul = sort.dir === 'asc' ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      if (sort.key === 'amount') {
        return ((totalByQuoteId.get(a.id) || 0) - (totalByQuoteId.get(b.id) || 0)) * mul;
      }
      if (sort.key === 'customer') {
        const an = (customerById.get(a.customerId)?.name || '').toLowerCase();
        const bn = (customerById.get(b.customerId)?.name || '').toLowerCase();
        return an.localeCompare(bn) * mul;
      }
      // recent
      return ((a.updatedAt || 0) - (b.updatedAt || 0)) * mul;
    });
    return sorted;
  }, [scopedQuotes, effectiveScope, q, tab, filters, sort, customerById, totalByQuoteId]);

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
        subtitle={`${scopedQuotes.length} ${scopedQuotes.length === 1 ? 'cotización' : 'cotizaciones'}`}
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
            customer={customerById.get(qu.customerId)}
            creator={profileById.get(qu.createdByUserId)}
            order={ordersById.get(qu.orderId)}
            total={totalByQuoteId.get(qu.id) || 0}
            rates={displayRatesFor(qu, settings)}
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
              <th className="hidden xl:table-cell">Creada por</th>
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
                creator={profileById.get(qu.createdByUserId)}
                order={ordersById.get(qu.orderId)}
                total={totalByQuoteId.get(qu.id) || 0}
                rates={displayRatesFor(qu, settings)}
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

function QuoteCard({ qu, customer, creator, order, total, rates }) {
  const { del } = useQuoteOps(qu);
  const creatorLabel = creatorDisplay(creator);

  return (
    <div className="card p-3">
      <Link to={`/quotes/${qu.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">#{qu.number || '—'}</div>
            <div className="text-xs text-ink-500 truncate">{customer?.name || 'Sin cliente'}</div>
            {creatorLabel && (
              <div className="text-[11px] text-ink-500 truncate">Creada por {creatorLabel}</div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-medium">{formatMoney(total, qu.currencyCode || 'USD', rates)}</div>
            <div className="text-[10px] text-ink-500">{formatDateTime(qu.updatedAt)}</div>
          </div>
        </div>
      </Link>
      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-ink-100">
        <StatusPill {...quoteStagePill(currentQuoteStage(qu))} />
        <TradeFlag quote={qu} />
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

function QuoteRow({ qu, customer, creator, order, total, rates }) {
  const { del } = useQuoteOps(qu);
  const creatorLabel = creatorDisplay(creator);

  return (
    <tr className="cursor-pointer" onClick={() => (window.location.hash = `#/quotes/${qu.id}`)}>
      <td className="font-medium whitespace-nowrap">#{qu.number || '—'}</td>
      <td className="text-ink-700 truncate max-w-[160px]" title={customer?.name || ''}>{customer?.name || '—'}</td>
      <td className="hidden xl:table-cell text-ink-500 truncate max-w-[140px]" title={creatorLabel}>
        {creatorLabel || '—'}
      </td>
      <td>
        <div className="flex items-center gap-1.5">
          <StatusPill {...quoteStagePill(currentQuoteStage(qu))} />
          <TradeFlag quote={qu} />
        </div>
      </td>
      <td><OrderIndicator order={order} /></td>
      <td className="hidden lg:table-cell text-ink-500 whitespace-nowrap">{formatDateTime(qu.updatedAt)}</td>
      <td className="text-right font-medium whitespace-nowrap">{formatMoney(total, qu.currencyCode || 'USD', rates)}</td>
      <td className="text-right w-12">
        <button onClick={del} className="text-ink-400 hover:text-red-600" title="Eliminar">
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
