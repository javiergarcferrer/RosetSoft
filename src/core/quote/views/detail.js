// ViewModels for the three detail pages — one order, one customer, one
// professional. Each is a single pure resolver the matching page renders
// straight from: the multi-step rollups (per-quote totals, stage/status
// grouping, dispatch gates, commission accrual) live here, so the page
// derives nothing and just maps the projection to JSX.
//
// MVVM: pages/OrderDetail.jsx, pages/CustomerDetail.jsx and
// pages/ProfessionalDetail.jsx render these. Pure: the page passes the
// already-fetched rows (order/quotes/lines/containers/customers/…) and reads
// the result. Every per-quote sum routes through the shared totals helpers so
// these surfaces agree to the cent with the dashboard and the list pages.
import { linesByQuoteId, quoteGrandTotal, quoteTotals } from '../totals.js';
import {
  ORDER_STAGE_BY_KEY, ORDER_STAGES,
  currentOrderStage, nextOrderStage, orderStageIndex,
  canAdvanceOrder, advanceBlockedReason, orderDispatchThreshold,
} from '../../../lib/orderStages.js';
import { QUOTE_STATUS_ACCEPTED } from '../../../lib/constants.js';
import {
  baseCommissionPct, commissionAmount, isTradeDiscount, reportedCommission,
} from '../../../lib/commissions.js';

// id → row, the small index every detail page builds to label its quotes.
function indexById(rows) {
  const m = new Map();
  for (const r of rows || []) m.set(r.id, r);
  return m;
}

// ---------------------------------------------------------------------------
// Order detail — the operational dashboard for one order. Resolves the stage
// machine (current/next/prev + the cancelled flag), the order-wide total (sum
// of every attached quote, container-agnostic per the dealer's rule), the
// dispatch-threshold widget figures, and the two advance gates. Totals are
// computed for BOTH the attached quotes and the unattached attach-picker
// candidates, since the picker sheet lists candidates and would otherwise show
// $0.00 per row.
//
// Tolerates `order == null` (the page renders a loading stub before its row
// arrives, and calls this inside a useMemo above that guard): the stage
// helpers default to 'draft' and the gates close, none of which the loading
// view renders.
// ---------------------------------------------------------------------------
export function resolveOrderDetail({
  order, quotes, unattachedQuotes, containers, lines, customers, settings,
}) {
  const qs = Array.isArray(quotes) ? quotes : [];
  const candidates = Array.isArray(unattachedQuotes) ? unattachedQuotes : [];
  const cs = Array.isArray(containers) ? containers : [];

  // Customers indexed by id — labels each quote (attached and candidate) with
  // its client name in the attach picker.
  const customerById = indexById(customers);

  // Per-quote totals through the canonical computeTotals path so compound
  // lines (qty/unitPrice=0 on the parent — math lives in `components`) roll up
  // correctly and line- + quote-level adjustments (discount, ITBIS, shipping)
  // are included. Covers the unattached candidates too, so the picker shows
  // real figures rather than $0.00.
  const linesByQuote = linesByQuoteId(lines);
  const totalByQuote = new Map();
  for (const q of [...qs, ...candidates]) {
    if (totalByQuote.has(q.id)) continue;
    // settings → a company-account quote on this order reads at dealer cost.
    totalByQuote.set(q.id, quoteGrandTotal(q, linesByQuote.get(q.id) || [], settings));
  }

  // Stage machine for the header + stepper.
  const stage = currentOrderStage(order);
  const stageDef = ORDER_STAGE_BY_KEY[stage];
  const isCancelled = stage === 'cancelled';
  const nxt = isCancelled ? null : nextOrderStage(stage);
  const idx = orderStageIndex(stage);
  // The previous main-track stage (for the "Volver" undo button).
  const prev = idx > 0 ? ORDER_STAGES[idx - 1] : null;

  // Roll-up: sum of all quote totals attached to this order. Per the dealer's
  // rule ("todas las cotizaciones aportan a ese total sin importar a cual
  // contenedor pertenecen") this is order-wide and doesn't try to attribute
  // totals to specific containers.
  const orderTotal = qs.reduce((acc, q) => acc + (totalByQuote.get(q.id) || 0), 0);

  // Dispatch threshold scales with the number of container rows. Floor of 1
  // means a fresh order without any containers still gets a meaningful
  // "minimum to place" indicator.
  const perContainerThreshold = Number(settings?.dispatchThreshold) || 50000;
  const { containerCount, threshold } = orderDispatchThreshold(cs, perContainerThreshold);
  const thresholdMet = orderTotal >= threshold;

  // Two gates fire on stage advance: draft → placed is blocked under the
  // dispatch minimum, in_customs → received until every container is packed.
  // The helpers in orderStages.js carry both rules.
  const gateOpts = { totalAmount: orderTotal, threshold };
  const canAdvance = canAdvanceOrder(order, cs, gateOpts);
  const blockedReason = advanceBlockedReason(order, cs, gateOpts);

  return {
    customerById,
    totalByQuote,
    stage,
    stageDef,
    isCancelled,
    nxt,
    idx,
    prev,
    orderTotal,
    containerCount,
    threshold,
    thresholdMet,
    canAdvance,
    blockedReason,
  };
}

// Orders sorted by stage progression — in-flight first, archived last.
const ORDER_STAGE_ORDER = [
  'received', 'in_customs', 'in_transit', 'confirmed', 'placed', 'draft', 'cancelled',
];

// ---------------------------------------------------------------------------
// Customer detail — the relationship history for one customer. Resolves the
// per-quote totals, the quotes grouped (and sorted) by status, the related
// orders (direct match OR any of the customer's quotes is attached, sorted by
// stage), and the committed / all-time value roll-ups.
// ---------------------------------------------------------------------------
export function resolveCustomerDetail({ customerId, quotes, orders, lines, settings }) {
  const qs = Array.isArray(quotes) ? quotes : [];
  const os = Array.isArray(orders) ? orders : [];
  const linesByQuote = linesByQuoteId(lines);

  // Per-quote total + grouping by status.
  const totalByQuote = new Map();
  const quotesByStatus = new Map();
  for (const q of qs) {
    // settings → the store customer's company-account quotes read at cost
    // (admin) / list (employee) and carry no ITBIS, like every other surface.
    totalByQuote.set(q.id, quoteGrandTotal(q, linesByQuote.get(q.id) || [], settings));
    const key = q.status || 'draft';
    if (!quotesByStatus.has(key)) quotesByStatus.set(key, []);
    quotesByStatus.get(key).push(q);
  }
  for (const arr of quotesByStatus.values()) {
    arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Orders related to this customer: direct match OR any quote of theirs is
  // attached. The relevant-order Set holds order ids that qualify; we then
  // pull the full order rows for rendering.
  const customerQuoteIds = new Set(qs.map((q) => q.id));
  const relevantOrderIds = new Set();
  for (const o of os) {
    if (o.customerId === customerId) relevantOrderIds.add(o.id);
  }
  for (const q of qs) {
    if (q.orderId) relevantOrderIds.add(q.orderId);
  }
  const relatedOrders = os.filter((o) => relevantOrderIds.has(o.id));
  // Sort orders by stage progression (in-flight first, archived last).
  relatedOrders.sort((a, b) => {
    // Stage via currentOrderStage (defaults to 'draft'), not the raw status —
    // a null/unknown status would otherwise indexOf to -1 and float to the top.
    const ai = ORDER_STAGE_ORDER.indexOf(currentOrderStage(a));
    const bi = ORDER_STAGE_ORDER.indexOf(currentOrderStage(b));
    if (ai !== bi) return ai - bi;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  // Roll-ups: accepted-quotes value, all-time value.
  const acceptedTotal = (quotesByStatus.get('accepted') || [])
    .reduce((s, q) => s + (totalByQuote.get(q.id) || 0), 0);
  const allTimeTotal = qs
    .reduce((s, q) => s + (totalByQuote.get(q.id) || 0), 0);

  return {
    totalByQuote,
    quotesByStatus,
    orders: relatedOrders,
    acceptedTotal,
    allTimeTotal,
    customerQuoteIds,
  };
}

// ---------------------------------------------------------------------------
// Professional detail — the commission roll-up for one professional. Resolves
// each assigned quote into a per-status entry (base imponible, grand total,
// effective rate, commission vs trade-discount split) and the overall +
// accepted-only summaries the headline cards show. Returns `byStatus` empty
// when the professional row hasn't loaded yet.
// ---------------------------------------------------------------------------
export function resolveProfessionalDetail({ pro, quotes, lines, customers }) {
  const qs = Array.isArray(quotes) ? quotes : [];
  const customerById = indexById(customers);

  // Group by status; inside each group precompute total + commission so the
  // table renders straight from this shape without re-doing the arithmetic on
  // every paint.
  const byStatus = new Map();
  if (pro) {
    const linesByQuote = linesByQuoteId(lines);
    for (const q of qs) {
      // Through the shared totals helper: compound lines collapse their
      // components, sections are stripped, and `unitPrice` → `basePrice` is
      // mapped for computeTotals.
      const totals = quoteTotals(q, linesByQuote.get(q.id) || []);
      const pct = baseCommissionPct(q);
      // Same rate, two AR directions. The $ amount is computed off the base
      // imponible (pre-ITBIS, pre-shipping) with any client discount drawn
      // out of it; whether it lands as a commission WE pay or a trade
      // discount WE bill the decorator is the per-quote modality. Trade
      // discount accrues no commission.
      // Once the commission is paid, freeze to the amount snapshotted at
      // payout so a later rate/order-type change can't restate this pro's
      // paid history; unpaid (and trade, which never pays a commission) stay
      // live. Trade discounts never set commissionPaidAt, so they pass through.
      const liveAmount = commissionAmount(totals, pct);
      const amount = reportedCommission(q.commissionPaidAt, q.commissionPaidAmount, liveAmount);
      const trade = isTradeDiscount(q);
      const entry = {
        quote: q,
        customer: q.customerId ? customerById.get(q.customerId) : null,
        base: totals.taxableBase,
        grandTotal: totals.grandTotal,
        pct,
        trade,
        amount,
        commission: trade ? 0 : amount,
        tradeDiscount: trade ? amount : 0,
      };
      const key = q.status || 'draft';
      if (!byStatus.has(key)) byStatus.set(key, []);
      byStatus.get(key).push(entry);
    }
    // Sort each group by most recent first — the dealer usually wants to see
    // the freshest deal at the top of each section.
    for (const arr of byStatus.values()) {
      arr.sort((a, b) => (b.quote.updatedAt || 0) - (a.quote.updatedAt || 0));
    }
  }

  // Overall roll-up across every status, plus accepted-only as the
  // "committed" figure the dealer cares about most for payouts. "Sales" here
  // is the taxable base — the same amount commissions are calculated on — so
  // the headline figures and the commission column always line up.
  let totalBase = 0;
  let totalCommission = 0;
  let totalTrade = 0;
  let acceptedBase = 0;
  let acceptedCommission = 0;
  let acceptedTrade = 0;
  for (const [status, entries] of byStatus) {
    for (const e of entries) {
      totalBase += e.base;
      totalCommission += e.commission;
      totalTrade += e.tradeDiscount;
      if (status === QUOTE_STATUS_ACCEPTED) {
        acceptedBase += e.base;
        acceptedCommission += e.commission;
        acceptedTrade += e.tradeDiscount;
      }
    }
  }

  return {
    grouped: byStatus,
    summary: {
      totalBase, totalCommission, totalTrade,
      acceptedBase, acceptedCommission, acceptedTrade,
    },
  };
}
