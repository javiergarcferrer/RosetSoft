// ViewModel for the seller Dashboard.
//
// MVVM: pages/Dashboard.jsx renders THIS — the per-quote deal value and the
// three work queues (sent to follow up, accepted with their next milestone,
// drafts to resume). Pure: the page passes the quotes/customers/lines + the
// resolved scope flag, and renders the result.
import { computeTotals, lineForTotals } from '../../../lib/pricing.js';
import { isPricedLine } from '../../../lib/constants.js';

// Accepted-quote next step, from the quote-level milestone chain
// (deposit → balance → delivery). `rank` sorts the most-pending to the top.
function acceptedNextStep(q) {
  if (!q.depositReceivedAt) return { label: 'Anticipo pendiente', cls: 'status-pill-pending', rank: 0 };
  if (!q.balancePaidAt)     return { label: 'Balance pendiente',  cls: 'status-pill-sent',    rank: 1 };
  if (!q.deliveredAt)       return { label: 'Entrega pendiente',  cls: 'status-pill-accepted', rank: 2 };
  return { label: 'Entregada', cls: 'status-pill-archived', rank: 3 };
}

export function resolveDashboard({ quotes, customers, lines, scopeIsTeam, meId }) {
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

  const sent = scoped
    .filter((q) => q.status === 'sent')
    .sort((a, b) => (a.sentAt || a.updatedAt || 0) - (b.sentAt || b.updatedAt || 0));

  const accepted = scoped
    .filter((q) => q.status === 'accepted')
    .map((q) => ({ q, step: acceptedNextStep(q) }))
    .sort((a, b) => a.step.rank - b.step.rank || (b.q.acceptedAt || 0) - (a.q.acceptedAt || 0));

  const drafts = scoped
    .filter((q) => q.status === 'draft')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return { customersById, totalByQuote, sent, accepted, drafts };
}
