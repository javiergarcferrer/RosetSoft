// ViewModel for the seller Dashboard.
//
// MVVM: pages/Dashboard.jsx renders THIS — the KPI strip numbers, the
// per-quote deal value, the three work queues (sent to follow up, accepted
// with their next milestone, drafts to resume) and the active-orders strip.
// Pure: the page passes the quotes/customers/lines/orders/containers + the
// resolved scope flag, and renders the result. `now` is injectable so the
// time-derived numbers (staleness, "won this month") stay testable.
import { linesByQuoteId, quoteGrandTotal } from '../totals.js';
import { currentOrderStage, ORDER_STAGE_BY_KEY } from '../../../lib/orderStages.js';
import { quoteOutstanding } from '../../../lib/quoteMilestones.js';
import { normalizeContainerNo, isValidContainerNo } from '../../../lib/containerTracking.js';

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
  quotes, customers, lines, orders, containers, settings, scopeIsTeam, meId, now = Date.now(),
  // Map<containerNo, { etaAt, etaLocation }> from useContainerEtas — optional;
  // absent/empty just leaves every order's `eta` null (the strip renders
  // immediately, ETAs hydrate in when the tracking calls land).
  etaByCode = null,
}) {
  const qs = Array.isArray(quotes) ? quotes : [];

  const customersById = new Map();
  for (const c of customers || []) customersById.set(c.id, c);

  // Route through the shared rollup like every other list/detail VM, so the
  // dashboard KPIs agree to the cent — incl. settings, which prices a
  // company-account quote at dealer cost (quoteGrandTotal applies the discount).
  const linesByQuote = linesByQuoteId(lines);
  const totalByQuote = new Map();
  for (const q of qs) {
    totalByQuote.set(q.id, quoteGrandTotal(q, linesByQuote.get(q.id) || [], settings));
  }

  const inScope = (q) => scopeIsTeam || q.createdByUserId === meId;
  const scoped = qs.filter(inScope);

  // USD deal-value rollup over a set of quotes — the tiles pair every count
  // with the money it represents (quotes are USD-base; see lib/format).
  const sumTotals = (arr) => arr.reduce((s, q) => s + (totalByQuote.get(q.id) || 0), 0);

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

  // Accepted → fulfillment queue. Each entry carries its total AND what the
  // customer still owes (quoteOutstanding), so the row and the "por cobrar"
  // KPI read the same money rule.
  const accepted = scoped
    .filter((q) => q.status === 'accepted')
    .map((q) => ({
      q,
      step: acceptedNextStep(q),
      total: totalByQuote.get(q.id) || 0,
      due: quoteOutstanding(q, totalByQuote.get(q.id) || 0),
    }))
    .sort((a, b) => a.step.rank - b.step.rank || (b.q.acceptedAt || 0) - (a.q.acceptedAt || 0));
  // "En proceso" = accepted with a milestone still pending (rank 3 = delivered).
  const inProcessCount = accepted.filter((a) => a.step.rank < 3).length;
  const dueValue = accepted.reduce((s, a) => s + a.due, 0);

  const drafts = scoped
    .filter((q) => q.status === 'draft')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

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
  // Trackable (valid ISO 6346) container numbers per order — what the page
  // feeds useContainerEtas, and what the ETA rollup below reads back.
  const codesByOrder = new Map();
  for (const c of containers || []) {
    if (!c.orderId) continue;
    containerCountByOrder.set(c.orderId, (containerCountByOrder.get(c.orderId) || 0) + 1);
    const code = normalizeContainerNo(c.code);
    if (isValidContainerNo(code)) {
      if (!codesByOrder.has(c.orderId)) codesByOrder.set(c.orderId, []);
      codesByOrder.get(c.orderId).push(code);
    }
  }
  const activeOrders = (orders || [])
    .filter((o) => !ORDER_DONE_STAGES.has(currentOrderStage(o)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((o) => {
      const direct = o.customerId ? customersById.get(o.customerId) : null;
      const stage = currentOrderStage(o);
      // When the order ENTERED its current stage — the strip shows how long
      // it's been sitting there (a stuck "en aduanas" should read as stuck).
      const stampField = ORDER_STAGE_BY_KEY[stage]?.timestampField;
      const containerCodes = codesByOrder.get(o.id) || [];
      // Completion ETA: an order is fully landed when its LAST container
      // arrives, so several tracked containers roll up to the LATEST estimate.
      let eta = null;
      for (const code of containerCodes) {
        const e = etaByCode?.get?.(code);
        if (e?.etaAt != null && (!eta || e.etaAt > eta.at)) {
          eta = { at: e.etaAt, location: e.etaLocation || null, code };
        }
      }
      return {
        order: o,
        stage,
        stageAt: (stampField && o[stampField]) || null,
        containerCodes,
        eta,
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
    // KPI strip — every number the tiles show, derived here. Each count is
    // paired with its USD value so the strip reads money, not just volume.
    kpis: {
      draftCount: drafts.length,
      draftValue: sumTotals(drafts),
      sentCount: sent.length,
      sentValue: sumTotals(sent.map((s) => s.q)),
      staleCount,
      inProcessCount,
      dueValue,
    },
    scopedCount: scoped.length,
  };
}
