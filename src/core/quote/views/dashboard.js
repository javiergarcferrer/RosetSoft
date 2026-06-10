// ViewModel for the seller Dashboard.
//
// MVVM: pages/Dashboard.jsx renders THIS — the KPI strip numbers, the
// per-quote deal value, the three work queues (sent to follow up, accepted
// with their next milestone, drafts to resume) and the active-orders strip.
// Pure: the page passes the quotes/customers/lines/orders/containers + the
// resolved scope flag, and renders the result. `now` is injectable so the
// time-derived numbers (staleness, "won this month") stay testable.
import { computeTotals, lineForTotals } from '../../../lib/pricing.js';
import { isPricedLine } from '../../../lib/constants.js';
import { currentOrderStage } from '../../../lib/orderStages.js';

// A sent quote waiting longer than this nudges a follow-up.
export const STALE_DAYS = 7;

const DAY_MS = 86400000;

// Order stages that mean "nothing left in flight" — everything else is a
// pedido en curso the seller may want to keep an eye on.
const ORDER_DONE_STAGES = new Set(['received', 'cancelled']);

// Accepted-quote next step, from the quote-level milestone chain
// (deposit → balance → delivery). `rank` sorts the most-pending to the top.
function acceptedNextStep(q) {
  if (!q.depositReceivedAt) return { label: 'Anticipo pendiente', cls: 'status-pill-pending', rank: 0 };
  if (!q.balancePaidAt)     return { label: 'Balance pendiente',  cls: 'status-pill-sent',    rank: 1 };
  if (!q.deliveredAt)       return { label: 'Entrega pendiente',  cls: 'status-pill-accepted', rank: 2 };
  return { label: 'Entregada', cls: 'status-pill-archived', rank: 3 };
}

export function resolveDashboard({
  quotes, customers, lines, orders, containers, scopeIsTeam, meId, now = Date.now(),
}) {
  const qs = Array.isArray(quotes) ? quotes : [];

  const customersById = new Map();
  for (const c of customers || []) customersById.set(c.id, c);

  const linesByQuote = new Map();
  for (const ln of lines || []) {
    if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
    linesByQuote.get(ln.quoteId).push(ln);
  }
  const totalByQuote = new Map();
  for (const q of qs) {
    const ls = (linesByQuote.get(q.id) || []).filter(isPricedLine).map(lineForTotals);
    totalByQuote.set(q.id, computeTotals(ls, q).grandTotal);
  }

  const inScope = (q) => scopeIsTeam || q.createdByUserId === meId;
  const scoped = qs.filter(inScope);

  // Sent → follow-up queue, OLDEST first; each entry carries its staleness
  // so the row accent and the KPI "sin respuesta" count read the same rule.
  const sent = scoped
    .filter((q) => q.status === 'sent')
    .sort((a, b) => (a.sentAt || a.updatedAt || 0) - (b.sentAt || b.updatedAt || 0))
    .map((q) => ({
      q,
      sinceTs: q.sentAt || q.updatedAt || 0,
      stale: !!q.sentAt && (now - q.sentAt) / DAY_MS >= STALE_DAYS,
    }));
  const staleCount = sent.filter((s) => s.stale).length;

  const accepted = scoped
    .filter((q) => q.status === 'accepted')
    .map((q) => ({ q, step: acceptedNextStep(q) }))
    .sort((a, b) => a.step.rank - b.step.rank || (b.q.acceptedAt || 0) - (a.q.acceptedAt || 0));
  // "En proceso" = accepted with a milestone still pending (rank 3 = delivered).
  const inProcessCount = accepted.filter((a) => a.step.rank < 3).length;

  const drafts = scoped
    .filter((q) => q.status === 'draft')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // Won this month — accepted (acceptedAt) since the 1st of the current
  // month, within scope, regardless of where fulfillment stands now.
  const monthStartDate = new Date(now);
  monthStartDate.setDate(1);
  monthStartDate.setHours(0, 0, 0, 0);
  const monthStart = monthStartDate.getTime();
  const wonThisMonth = scoped.filter((q) => (q.acceptedAt || 0) >= monthStart).length;

  // ---- Pedidos en curso — orders not yet received/cancelled, with the cheap
  // per-order rollups the strip shows. Orders are the team's shared logistics
  // pipeline, so this section deliberately ignores the Mías/Equipo scope.
  const quoteCountByOrder = new Map();
  const totalByOrder = new Map();
  const customerLabelByOrder = new Map();
  for (const q of qs) {
    if (!q.orderId) continue;
    quoteCountByOrder.set(q.orderId, (quoteCountByOrder.get(q.orderId) || 0) + 1);
    totalByOrder.set(q.orderId, (totalByOrder.get(q.orderId) || 0) + (totalByQuote.get(q.id) || 0));
    // First attached quote's customer doubles as the order label fallback.
    if (!customerLabelByOrder.has(q.orderId) && q.customerId) {
      const c = customersById.get(q.customerId);
      if (c) customerLabelByOrder.set(q.orderId, c.company || c.name || '');
    }
  }
  const containerCountByOrder = new Map();
  for (const c of containers || []) {
    if (!c.orderId) continue;
    containerCountByOrder.set(c.orderId, (containerCountByOrder.get(c.orderId) || 0) + 1);
  }
  const activeOrders = (orders || [])
    .filter((o) => !ORDER_DONE_STAGES.has(currentOrderStage(o)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((o) => {
      const direct = o.customerId ? customersById.get(o.customerId) : null;
      return {
        order: o,
        stage: currentOrderStage(o),
        customerLabel: (direct && (direct.company || direct.name)) || customerLabelByOrder.get(o.id) || null,
        quoteCount: quoteCountByOrder.get(o.id) || 0,
        containerCount: containerCountByOrder.get(o.id) || 0,
        total: totalByOrder.get(o.id) || 0,
      };
    });

  return {
    customersById,
    totalByQuote,
    sent,
    accepted,
    drafts,
    activeOrders,
    // KPI strip — every number the tiles show, derived here.
    kpis: {
      draftCount: drafts.length,
      sentCount: sent.length,
      staleCount,
      inProcessCount,
      wonThisMonth,
    },
    scopedCount: scoped.length,
  };
}
