import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, Truck, ArrowRight, Plus, TrendingUp,
} from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import ListLoading from '../components/ListLoading.jsx';
import StatCard from '../components/StatCard.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db } from '../db/database.js';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { computeTotals } from '../lib/pricing.js';
import { ORDER_STAGE_BY_KEY } from '../lib/orderStages.js';

/**
 * Operational dashboard — a single-screen "what's happening right now"
 * view. Replaces the earlier counts-and-recent-quotes layout, which was
 * just a stat tally and a table.
 *
 * Sections, top to bottom:
 *
 *   1. Three KPI cards — committed pipeline (sum of accepted quotes),
 *      open pipeline (drafts + sent), and in-fulfillment containers.
 *      Each card links to the relevant list view.
 *
 *   2. Two-column row:
 *      • Pipeline-by-status — mini bar chart of quotes per status with
 *        running money totals per row.
 *      • Containers in fulfillment — the operationally-urgent view.
 *        Lists every container that's not yet 'received', ordered by
 *        stage, with the order's customer name + days-in-stage.
 *
 *   3. Recent activity — last N quote and order timestamps.
 *
 *   4. Top professionals (this month, by accrued commission) +
 *      recent quotes (table).
 *
 * Everything reads from useLiveQueryStatus so the empty / loading
 * states are honest — no flicker of "0 cotizaciones" on every mount.
 */

// Plural labels — used in the pipeline-bar header where each row is a
// *group* of quotes (`Aceptadas · 4 · $142k`).
const QUOTE_STATUS_GROUP = {
  draft: 'Borradores',
  sent: 'Enviadas',
  accepted: 'Aceptadas',
  declined: 'Rechazadas',
  archived: 'Archivadas',
};

// Singular labels — used inside per-quote pills (a single quote can't be
// "Aceptadas"; it's "Aceptada"). Same vocabulary as Quotes.jsx.
const QUOTE_STATUS_LABEL = {
  draft: 'Borrador',
  sent: 'Enviada',
  accepted: 'Aceptada',
  declined: 'Rechazada',
  archived: 'Archivada',
};

const QUOTE_STATUS_TONES = {
  draft: 'bg-ink-200',
  sent: 'bg-blue-400',
  accepted: 'bg-emerald-500',
  declined: 'bg-red-400',
  archived: 'bg-ink-300',
};
const STATUS_PILL_CLASS = {
  draft: 'status-pill-draft',
  sent: 'status-pill-sent',
  accepted: 'status-pill-accepted',
  declined: 'status-pill-declined',
  archived: 'status-pill-archived',
};

export default function Dashboard() {
  const { profileId, settings } = useApp();

  // All the queries we need. Each returns its own `loaded` flag so we
  // can gate per-section UI individually — the customer roll-up doesn't
  // have to wait for orders to render. In practice they all resolve at
  // roughly the same time on a warm fetch.
  const allQuotesQ = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const allOrdersQ = useLiveQueryStatus(
    () => db.orders.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const allCustomersQ = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const allContainersQ = useLiveQueryStatus(
    () => db.containers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  // Lines drive total-money roll-ups. Fetched in one shot rather than
  // per-quote because the dashboard touches many quotes' totals at once.
  const allLinesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);

  const allQuotes    = allQuotesQ.data;
  const allOrders    = allOrdersQ.data;
  const allCustomers = allCustomersQ.data;
  const allContainers= allContainersQ.data;
  const allLines     = allLinesQ.data;
  const loaded =
    allQuotesQ.loaded && allOrdersQ.loaded && allCustomersQ.loaded &&
    allContainersQ.loaded && allLinesQ.loaded;

  // ---- Derive everything from the raw rows --------------------------------
  // We do all the math in a single useMemo so the dashboard re-renders
  // exactly once per data change rather than per per-query resolve.
  const derived = useMemo(() => {
    const customersById = new Map();
    for (const c of allCustomers) customersById.set(c.id, c);
    const linesByQuote = new Map();
    for (const ln of allLines) {
      if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
      linesByQuote.get(ln.quoteId).push(ln);
    }

    // Per-quote grand total (post-margin/discount/tax/shipping) — same
    // shape computeTotals expects, with unitPrice mapped to basePrice.
    const totalByQuote = new Map();
    for (const q of allQuotes) {
      const lines = (linesByQuote.get(q.id) || [])
        .filter((l) => l.kind !== 'section')
        .map((l) => ({
          qty: l.qty,
          basePrice: l.unitPrice,
          lineMarginPct: l.lineMarginPct,
          lineDiscountPct: l.lineDiscountPct,
        }));
      const t = computeTotals(lines, q);
      totalByQuote.set(q.id, t.grandTotal);
    }

    // Quotes grouped by status — drives the pipeline bar chart and the
    // KPI "committed pipeline" (accepted only) and "open pipeline"
    // (draft + sent) figures.
    const quotesByStatus = new Map();
    for (const q of allQuotes) {
      const key = q.status || 'draft';
      if (!quotesByStatus.has(key)) quotesByStatus.set(key, []);
      quotesByStatus.get(key).push(q);
    }
    function sumGroup(status) {
      const group = quotesByStatus.get(status) || [];
      return group.reduce((s, q) => s + (totalByQuote.get(q.id) || 0), 0);
    }
    const committedTotal = sumGroup('accepted');
    const openTotal = sumGroup('draft') + sumGroup('sent');
    const acceptedCount = (quotesByStatus.get('accepted') || []).length;
    const openCount =
      (quotesByStatus.get('draft') || []).length +
      (quotesByStatus.get('sent') || []).length;

    // Orders in active fulfillment — anything between 'placed' (PO sent
    // to LR) and just before 'received' (still en route). The dashboard
    // shows the order's current stage, customer name, and how many
    // containers are filled vs total. Previously this section was
    // container-driven, but containers no longer carry per-stage
    // narrative — that lives on the order now.
    const ordersById = new Map();
    for (const o of allOrders) ordersById.set(o.id, o);
    const containersByOrder = new Map();
    for (const c of allContainers) {
      if (!c.orderId) continue;
      if (!containersByOrder.has(c.orderId)) containersByOrder.set(c.orderId, []);
      containersByOrder.get(c.orderId).push(c);
    }
    const ACTIVE = new Set(['placed', 'confirmed', 'in_transit', 'in_customs']);
    const inFulfillment = allOrders
      .filter((o) => ACTIVE.has(o.status))
      .map((o) => {
        const customer = o.customerId ? customersById.get(o.customerId) : null;
        const containers = containersByOrder.get(o.id) || [];
        const filled = containers.filter((c) => !!c.filledAt).length;
        // Days since the order's most recent stage transition. We pick
        // the latest of the per-stage timestamps as the proxy — that's
        // when the order entered its current state.
        const stageStart = Math.max(
          o.placedAt || 0,
          o.confirmedAt || 0,
          o.inTransitAt || 0,
          o.inCustomsAt || 0,
        );
        const daysInStage = stageStart
          ? Math.max(0, Math.floor((Date.now() - stageStart) / 86400000))
          : null;
        return { order: o, customer, containers, filled, daysInStage };
      })
      .sort((a, b) => {
        // Late-stage orders (closer to received) above earlier-stage;
        // within a stage, oldest first so the dealer sees what's been
        // sitting longest.
        const ai = orderStageRank(a.order.status);
        const bi = orderStageRank(b.order.status);
        if (ai !== bi) return bi - ai;
        return (b.daysInStage || 0) - (a.daysInStage || 0);
      });

    // Recent quotes, most-recently-updated first, capped at 8 rows.
    const recentQuotes = [...allQuotes]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 8);

    return {
      customersById,
      totalByQuote,
      quotesByStatus,
      committedTotal,
      openTotal,
      acceptedCount,
      openCount,
      inFulfillment,
      recentQuotes,
    };
  }, [allQuotes, allOrders, allCustomers, allContainers, allLines]);

  return (
    <>
      <PageHeader
        title="Inicio"
        subtitle={settings?.companyName || 'Tu empresa'}
        actions={
          <Link to="/quotes/new" className="btn-primary">
            <Plus size={14} /> Nueva cotización
          </Link>
        }
      />

      {/* Row 1 — Cotizaciones recientes promoted to the top.
          The dealer's most-visited surface, so it gets the prime
          slot directly under the page header. */}
      <RecentQuotesCard
        loaded={loaded}
        quotes={derived.recentQuotes}
        customersById={derived.customersById}
        totalByQuote={derived.totalByQuote}
      />

      {/* Row 2 — three KPI summaries. All labels are Spanish; the
          previous "Pipeline" / "Fulfillment" anglicisms are gone.*/}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
        <StatCard
          icon={TrendingUp}
          tone="emerald"
          label="Comprometido"
          value={loaded ? formatMoney(derived.committedTotal, 'USD', { USD: 1 }) : '—'}
          hint={loaded ? `${derived.acceptedCount} cotización${derived.acceptedCount === 1 ? '' : 'es'} aceptada${derived.acceptedCount === 1 ? '' : 's'}` : 'Cargando…'}
          to="/quotes?status=accepted"
        />
        <StatCard
          icon={FileText}
          tone="brand"
          label="Cotizaciones abiertas"
          value={loaded ? formatMoney(derived.openTotal, 'USD', { USD: 1 }) : '—'}
          hint={loaded ? `${derived.openCount} entre borrador y enviada` : 'Cargando…'}
          to="/quotes"
        />
        <StatCard
          icon={Truck}
          tone="ink"
          label="Pedidos activos"
          value={loaded ? String(derived.inFulfillment.length) : '—'}
          hint={loaded
            ? (derived.inFulfillment.length
                ? `pedido${derived.inFulfillment.length === 1 ? '' : 's'} en proceso de despacho`
                : 'sin pedidos en despacho')
            : 'Cargando…'}
          to="/orders"
        />
      </div>

      {/* Row 3 — Cotizaciones aceptadas (replaces the old "Pipeline"
          widget) + the orders-in-despacho list. The pipeline widget
          had five rows (drafts/sent/accepted/declined/archived); per
          the dealer's instruction we show only `enviadas` and
          `aceptadas` — the two statuses that represent active money
          in the funnel. Drafts can change, declined never close,
          archived is historical — none earn space on the home view. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <AcceptedQuotesCard
          loaded={loaded}
          quotesByStatus={derived.quotesByStatus}
          totalByQuote={derived.totalByQuote}
        />
        <FulfillmentCard
          loaded={loaded}
          entries={derived.inFulfillment}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cotizaciones aceptadas — the focused replacement for the prior
// 5-row pipeline widget. Per the dealer's instruction we show only the
// two statuses that represent active money in the funnel:
//
//   • Enviadas  — quotes out to customers, awaiting yes/no
//   • Aceptadas — quotes the customer has agreed to; committed money
//
// Drafts, declined, and archived all stay one click away in the Cotizaciones
// list but no longer earn dashboard real estate. Each row is a click-
// through that filters /quotes by that status.
// ---------------------------------------------------------------------------
function AcceptedQuotesCard({ loaded, quotesByStatus, totalByQuote }) {
  const rows = ['sent', 'accepted'].map((status) => {
    const list = quotesByStatus.get(status) || [];
    const total = list.reduce((s, q) => s + (totalByQuote.get(q.id) || 0), 0);
    return { status, count: list.length, total };
  });
  const maxCount = Math.max(1, ...rows.map((r) => r.count));

  return (
    <section className="card overflow-hidden">
      <header className="card-header">
        <h2>Cotizaciones aceptadas</h2>
        <Link to="/quotes" className="card-header-action">
          Ver todas <ArrowRight size={12} />
        </Link>
      </header>
      {!loaded ? (
        <ListLoading rows={2} dense />
      ) : (
        <ul className="p-3 space-y-2">
          {rows.map((r) => (
            <li key={r.status}>
              <Link
                to={`/quotes?status=${r.status}`}
                className="block hover:bg-ink-50 rounded-md px-2 py-1.5 transition-colors"
              >
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-ink-700 font-medium">{QUOTE_STATUS_GROUP[r.status]}</span>
                  <span className="text-ink-500 tabular-nums">
                    {r.count} · <span className="text-ink-700">{formatMoney(r.total, 'USD', { USD: 1 })}</span>
                  </span>
                </div>
                <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden mt-1">
                  <div
                    className={`h-full rounded-full ${QUOTE_STATUS_TONES[r.status]}`}
                    style={{ width: `${(r.count / maxCount) * 100}%` }}
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Containers-in-fulfillment card. The operational urgency view: every
// container that hasn't reached 'received' yet, ordered by stage
// progression. Each row shows the container's number, the customer's
// name, the current stage, and how long it has been sitting there.
// ---------------------------------------------------------------------------
function FulfillmentCard({ loaded, entries }) {
  return (
    <section className="card overflow-hidden">
      <header className="card-header">
        <h2 className="flex items-center gap-2">
          <Truck size={14} className="text-ink-500" />
          Pedidos en despacho
        </h2>
        <Link to="/orders" className="card-header-action">
          Ver pedidos <ArrowRight size={12} />
        </Link>
      </header>
      {!loaded ? (
        <ListLoading rows={4} dense />
      ) : entries.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-500">
          Sin pedidos en proceso de despacho en este momento.
        </div>
      ) : (
        <ul className="divide-y divide-ink-100 max-h-[280px] overflow-y-auto">
          {entries.slice(0, 8).map(({ order, customer, containers, filled, daysInStage }) => {
            const stage = ORDER_STAGE_BY_KEY[order.status] || ORDER_STAGE_BY_KEY.placed;
            const total = containers.length;
            return (
              <li key={order.id}>
                <Link
                  to={`/orders/${order.id}`}
                  className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors"
                >
                  <div className="text-[10px] font-mono text-ink-500 w-12 flex-shrink-0">
                    #{order.number || '—'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {customer?.company || customer?.name || `Pedido #${order.number}`}
                    </div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {stage.label}
                      {total > 0 && (
                        <span className="text-ink-400"> · {filled}/{total} contenedor{total === 1 ? '' : 'es'} llenos</span>
                      )}
                      {daysInStage != null && (
                        <span className="text-ink-400"> · {daysInStage} día{daysInStage === 1 ? '' : 's'}</span>
                      )}
                    </div>
                  </div>
                  <ArrowRight size={12} className="text-ink-300 flex-shrink-0" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent quotes, condensed. Promoted to the first row of the dashboard —
// the dealer's most-touched surface, so it gets the prime slot directly
// under the page header. Shows quote number, customer, status pill, total.
// ---------------------------------------------------------------------------
function RecentQuotesCard({ loaded, quotes, customersById, totalByQuote }) {
  return (
    <section className="card overflow-hidden">
      <header className="card-header">
        <h2>Cotizaciones recientes</h2>
        <Link to="/quotes" className="card-header-action">
          Ver todas <ArrowRight size={12} />
        </Link>
      </header>
      {!loaded ? (
        <ListLoading rows={5} dense />
      ) : quotes.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-ink-500">
          Aún no hay cotizaciones.
        </div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {quotes.map((q) => {
            const customer = customersById.get(q.customerId);
            const total = totalByQuote.get(q.id) || 0;
            return (
              <li key={q.id}>
                <Link
                  to={`/quotes/${q.id}`}
                  className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors"
                >
                  <div className="text-sm font-medium tabular-nums whitespace-nowrap w-16 flex-shrink-0">
                    #{q.number || '—'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{customer?.company || customer?.name || 'Sin cliente'}</div>
                    <div className="text-[11px] text-ink-500 truncate">{formatDateTime(q.updatedAt)}</div>
                  </div>
                  <span className={`hidden sm:inline-flex status-pill ${STATUS_PILL_CLASS[q.status] || 'status-pill-draft'}`}>
                    {QUOTE_STATUS_LABEL[q.status] || 'Borrador'}
                  </span>
                  <div className="text-sm font-medium tabular-nums whitespace-nowrap w-24 text-right flex-shrink-0">
                    {formatMoney(total, q.currencyCode || 'USD', q.rates || { USD: 1 })}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// Map order status → progression index so the fulfillment list can
// sort late-stage orders to the top (closer to received = higher
// priority for the dealer's attention).
const ORDER_PROGRESSION = ['draft', 'placed', 'confirmed', 'in_transit', 'in_customs', 'received'];
function orderStageRank(status) {
  const i = ORDER_PROGRESSION.indexOf(status || 'draft');
  return i === -1 ? 0 : i;
}
