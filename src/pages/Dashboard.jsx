import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, Users, Package, Truck, ArrowRight, Plus, UserSquare2,
  TrendingUp, Wallet, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import ListLoading from '../components/ListLoading.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db } from '../db/database.js';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { computeTotals } from '../lib/pricing.js';
import { ORDER_STAGE_BY_KEY } from '../lib/orderStages.js';
import { effectiveCommissionPct, commissionAmount } from '../lib/commissions.js';

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
const QUOTE_STATUS_PILL = {
  draft: 'bg-ink-100 text-ink-700',
  sent: 'bg-blue-100 text-blue-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  declined: 'bg-red-100 text-red-700',
  archived: 'bg-ink-100 text-ink-500',
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
  const allProsQ = useLiveQueryStatus(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  // Lines drive total-money roll-ups. Fetched in one shot rather than
  // per-quote because the dashboard touches many quotes' totals at once.
  const allLinesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);

  const allQuotes    = allQuotesQ.data;
  const allOrders    = allOrdersQ.data;
  const allCustomers = allCustomersQ.data;
  const allContainers= allContainersQ.data;
  const allPros      = allProsQ.data;
  const allLines     = allLinesQ.data;
  const loaded =
    allQuotesQ.loaded && allOrdersQ.loaded && allCustomersQ.loaded &&
    allContainersQ.loaded && allProsQ.loaded && allLinesQ.loaded;

  // ---- Derive everything from the raw rows --------------------------------
  // We do all the math in a single useMemo so the dashboard re-renders
  // exactly once per data change rather than per per-query resolve.
  const derived = useMemo(() => {
    const customersById = new Map();
    for (const c of allCustomers) customersById.set(c.id, c);
    const prosById = new Map();
    for (const p of allPros) prosById.set(p.id, p);
    const linesByQuote = new Map();
    for (const ln of allLines) {
      if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
      linesByQuote.get(ln.quoteId).push(ln);
    }

    // Per-quote grand total (post-margin/discount/tax/shipping) — same
    // shape computeTotals expects, with unitPrice mapped to basePrice.
    const totalByQuote = new Map();
    const commissionByQuote = new Map();
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
      if (q.professionalId) {
        const pro = prosById.get(q.professionalId);
        const pct = effectiveCommissionPct(q, pro);
        commissionByQuote.set(q.id, commissionAmount(t.grandTotal, pct));
      }
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

    // Commissions accrued this calendar month, per professional, on
    // *accepted* quotes only. Drafts can change, declined never close —
    // accepted is the conservative "real" pipeline.
    const monthStart = startOfMonth();
    const commissionsByPro = new Map();
    for (const q of allQuotes) {
      if (q.status !== 'accepted') continue;
      if ((q.acceptedAt || q.updatedAt || 0) < monthStart) continue;
      if (!q.professionalId) continue;
      const c = commissionByQuote.get(q.id) || 0;
      commissionsByPro.set(q.professionalId, (commissionsByPro.get(q.professionalId) || 0) + c);
    }
    const topPros = [...commissionsByPro.entries()]
      .map(([id, amount]) => ({ pro: prosById.get(id), amount }))
      .filter((r) => r.pro)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

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
      topPros,
      recentQuotes,
    };
  }, [allQuotes, allOrders, allCustomers, allContainers, allPros, allLines]);

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

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          icon={TrendingUp}
          tone="emerald"
          label="Comprometido"
          value={loaded ? formatMoney(derived.committedTotal, 'USD', { USD: 1 }) : '—'}
          hint={loaded ? `${derived.acceptedCount} cotización${derived.acceptedCount === 1 ? '' : 'es'} aceptada${derived.acceptedCount === 1 ? '' : 's'}` : 'Cargando…'}
          to="/quotes?status=accepted"
        />
        <KpiCard
          icon={FileText}
          tone="brand"
          label="En el pipeline"
          value={loaded ? formatMoney(derived.openTotal, 'USD', { USD: 1 }) : '—'}
          hint={loaded ? `${derived.openCount} entre borrador y enviada` : 'Cargando…'}
          to="/quotes"
        />
        <KpiCard
          icon={Truck}
          tone="ink"
          label="En fulfillment"
          value={loaded ? String(derived.inFulfillment.length) : '—'}
          hint={loaded
            ? (derived.inFulfillment.length
                ? `contenedor${derived.inFulfillment.length === 1 ? '' : 'es'} en tránsito`
                : 'sin contenedores activos')
            : 'Cargando…'}
          to="/orders"
        />
      </div>

      {/* Pipeline + in-fulfillment */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <PipelineCard
          loaded={loaded}
          quotesByStatus={derived.quotesByStatus}
          totalByQuote={derived.totalByQuote}
        />
        <FulfillmentCard
          loaded={loaded}
          entries={derived.inFulfillment}
        />
      </div>

      {/* Bottom row: top professionals + recent quotes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <TopProfessionalsCard
          loaded={loaded}
          entries={derived.topPros}
        />
        <RecentQuotesCard
          loaded={loaded}
          quotes={derived.recentQuotes}
          customersById={derived.customersById}
          totalByQuote={derived.totalByQuote}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// KPI card — large headline number on top, small icon top-right, hint
// at the bottom. Wraps the whole card in a Link so the dealer can click
// through to the relevant list (committed → accepted quotes, etc.).
// ---------------------------------------------------------------------------
function KpiCard({ icon: Icon, label, value, hint, to, tone = 'ink' }) {
  const toneClasses = {
    emerald: 'text-emerald-600 bg-emerald-50',
    brand: 'text-brand-700 bg-brand-50',
    ink: 'text-ink-700 bg-ink-100',
  };
  return (
    <Link to={to} className="card card-pad hover:border-ink-300 transition-colors group">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</div>
          <div className="text-2xl sm:text-3xl font-semibold mt-1.5 tabular-nums truncate">{value}</div>
          <div className="text-xs text-ink-500 mt-1">{hint}</div>
        </div>
        <div className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors flex-shrink-0 ${toneClasses[tone]}`}>
          <Icon size={18} />
        </div>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Pipeline-by-status bar chart card. Each row: status label + bar +
// (count, money total). Bars are proportional to the *count* of quotes
// in each status; the money total is the auxiliary number. We picked
// count over money for the bar because the bar is showing flow volume
// (how many quotes are in each stage); the money sits as context.
// ---------------------------------------------------------------------------
function PipelineCard({ loaded, quotesByStatus, totalByQuote }) {
  const rows = ['draft', 'sent', 'accepted', 'declined', 'archived'].map((status) => {
    const list = quotesByStatus.get(status) || [];
    const total = list.reduce((s, q) => s + (totalByQuote.get(q.id) || 0), 0);
    return { status, count: list.length, total };
  });
  const maxCount = Math.max(1, ...rows.map((r) => r.count));

  return (
    <section className="card overflow-hidden">
      <header className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
        <h2 className="font-semibold">Pipeline de cotizaciones</h2>
        <Link to="/quotes" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1">
          Ver todas <ArrowRight size={12} />
        </Link>
      </header>
      {!loaded ? (
        <ListLoading rows={5} dense />
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
      <header className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
        <h2 className="font-semibold flex items-center gap-2">
          <Truck size={14} className="text-ink-500" />
          En fulfillment
        </h2>
        <Link to="/orders" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1">
          Ver pedidos <ArrowRight size={12} />
        </Link>
      </header>
      {!loaded ? (
        <ListLoading rows={4} dense />
      ) : entries.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-500">
          Sin pedidos en fulfillment en este momento.
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
// Top professionals (commission this month). Empty when no commissions
// have accrued — better than rendering "0" rows that look like a bug.
// ---------------------------------------------------------------------------
function TopProfessionalsCard({ loaded, entries }) {
  return (
    <section className="card overflow-hidden lg:col-span-1">
      <header className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
        <h2 className="font-semibold flex items-center gap-2">
          <UserSquare2 size={14} className="text-ink-500" />
          Profesionales (mes)
        </h2>
        <Link to="/professionals" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1">
          Ver todos <ArrowRight size={12} />
        </Link>
      </header>
      {!loaded ? (
        <ListLoading rows={3} dense />
      ) : entries.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-500">
          Sin comisiones acreditadas este mes.
        </div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {entries.map((e) => (
            <li key={e.pro.id}>
              <Link
                to={`/professionals/${e.pro.id}`}
                className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{e.pro.name}</div>
                  {e.pro.company && <div className="text-[11px] text-ink-500 truncate">{e.pro.company}</div>}
                </div>
                <div className="text-sm font-medium tabular-nums whitespace-nowrap">
                  {formatMoney(e.amount, 'USD', { USD: 1 })}
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
// Recent quotes, condensed. Two columns wide on desktop because the
// other side (TopProfessionalsCard) only needs one. Shows quote number,
// customer, status pill, total.
// ---------------------------------------------------------------------------
function RecentQuotesCard({ loaded, quotes, customersById, totalByQuote }) {
  return (
    <section className="card overflow-hidden lg:col-span-2">
      <header className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
        <h2 className="font-semibold">Cotizaciones recientes</h2>
        <Link to="/quotes" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1">
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
                  <span className={`hidden sm:inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${QUOTE_STATUS_PILL[q.status] || 'bg-ink-100 text-ink-700'}`}>
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
