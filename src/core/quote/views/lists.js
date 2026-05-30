// ViewModels for the two list pages — pages/Quotes.jsx and pages/Orders.jsx.
//
// MVVM: each page keeps its interactive state (scope / search / tab / filters /
// sort) in React and renders THESE projections — it derives nothing itself. Both
// functions are pure: the page passes the raw rows plus the resolved state and
// gets back the lookups, counts, sorted result list and grouping the view reads
// straight through. Per-quote money always routes through totals.js so the list
// figures agree to the cent with the dashboard and the detail pages.
import { linesByQuoteId, quoteGrandTotal } from '../totals.js';
import { resolveTrackableContainers } from '../../tracking/index.js';
import { SCOPE_TEAM } from '../../../components/ScopeToggle.jsx';
import { currentQuoteStage } from '../../../lib/quoteStages.js';
import { quoteStagePill } from '../../../lib/statusPill.js';

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

// ViewModel for pages/Quotes.jsx. `scope` is the raw Mías/Equipo toggle and
// `meId` the signed-in seller (or null); the effective scope is resolved here
// exactly as the page used to so the whole projection reflects the toggle.
export function resolveQuotesList({
  quotes, customers, profiles, orders, containers, lines,
  scope, meId, q, tab, filters, sort,
}) {
  const customerById = new Map();
  for (const c of customers) customerById.set(c.id, c);

  // Profiles include the shared 'team' settings row alongside real
  // users; the lookup is keyed by auth.uid() so we hit only the
  // matching employee on each quote.createdByUserId reference.
  const profileById = new Map();
  for (const p of profiles) profileById.set(p.id, p);

  const ordersById = new Map();
  for (const o of orders) ordersById.set(o.id, o);

  // orderId → that order's TRACKABLE containers (valid ISO 6346 number), so a
  // quote row offers tracking only when its order has a real shipment to track.
  const trackableByOrderId = new Map();
  for (const c of resolveTrackableContainers(containers)) {
    if (!c.orderId) continue;
    if (!trackableByOrderId.has(c.orderId)) trackableByOrderId.set(c.orderId, []);
    trackableByOrderId.get(c.orderId).push(c);
  }

  // Per-quote grand total. Previously inline `qty * unitPrice`, which
  // (a) ignored compound lines (their own qty/unitPrice are 0 by
  // design — the math lives in `components`) so a compound quote showed
  // $0 in the list, and (b) ignored every adjustment: line discount,
  // quote-level margin / discount, ITBIS, shipping. Routes the same way
  // Dashboard / CustomerDetail / ProfessionalDetail do — single source
  // of truth for the figure the dealer scans down this column.
  const linesByQuote = linesByQuoteId(lines);
  const totalByQuoteId = new Map();
  for (const qu of quotes) {
    totalByQuoteId.set(qu.id, quoteGrandTotal(qu, linesByQuote.get(qu.id) || []));
  }

  // Apply the Mías / Equipo scope FIRST — every downstream view (tab
  // counts, the vendedor filter options, the result list) reads from this
  // so the whole page reflects the toggle, not just the rows.
  const effectiveScope = meId ? scope : SCOPE_TEAM;
  const scopedQuotes = effectiveScope === SCOPE_TEAM
    ? quotes
    : quotes.filter((qu) => qu.createdByUserId === meId);

  // Tabs for the primary status dimension. Counts are computed off the
  // scoped list so each tab shows "how many would I see if I tapped this"
  // within the current scope, independent of the search needle.
  // Count by the derived lifecycle stage (currentQuoteStage), so a quote
  // with a deposit shows under "Depósito recibido" — same dimension the
  // status pill and the order page use.
  const counts = { draft: 0, sent: 0, accepted: 0, deposito_recibido: 0, declined: 0, archived: 0 };
  for (const qu of scopedQuotes) {
    const stage = currentQuoteStage(qu);
    if (stage in counts) counts[stage] += 1;
  }
  const tabs = [
    { key: 'all', label: 'Todas', count: scopedQuotes.length },
    { key: 'draft', label: 'Borrador', count: counts.draft, pillCls: quoteStagePill('draft').cls },
    { key: 'sent', label: 'Enviada', count: counts.sent, pillCls: quoteStagePill('sent').cls },
    { key: 'accepted', label: 'Aceptada', count: counts.accepted, pillCls: quoteStagePill('accepted').cls },
    { key: 'deposito_recibido', label: 'Depósito recibido', count: counts.deposito_recibido, pillCls: quoteStagePill('deposito_recibido').cls },
    { key: 'declined', label: 'Rechazada', count: counts.declined, pillCls: quoteStagePill('declined').cls },
    { key: 'archived', label: 'Archivada', count: counts.archived, pillCls: quoteStagePill('archived').cls },
  ];

  // Secondary filter: vendedor (the quote's creator). Options are the
  // distinct creators actually present on this team's quotes, so the
  // dropdown never lists someone who's authored nothing.
  const seen = new Map();
  for (const qu of quotes) {
    const id = qu.createdByUserId;
    if (!id || seen.has(id)) continue;
    const label = creatorDisplay(profileById.get(id));
    if (label) seen.set(id, label);
  }
  const creatorFilter = {
    key: 'creator',
    label: 'Vendedor',
    type: 'select',
    placeholder: 'Todos',
    options: [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };

  const needle = q.trim().toLowerCase();
  // The vendedor filter only applies in team scope — under "Mías" you're
  // already scoped to yourself, so it's hidden and ignored.
  const creator = effectiveScope === SCOPE_TEAM ? filters.creator : null;
  const matched = scopedQuotes
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
  const filtered = [...matched].sort((a, b) => {
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

  // One track button per ORDER, not per quote: several quotes can share an
  // order and would otherwise each repeat an identical "Rastrear envío" for the
  // same containers. Give the tracker to the first quote of each order in the
  // current list order; the rest render without it.
  const trackingByQuoteId = new Map();
  {
    const seenOrders = new Set();
    for (const qu of filtered) {
      const conts = qu.orderId ? trackableByOrderId.get(qu.orderId) : null;
      if (conts?.length && !seenOrders.has(qu.orderId)) {
        seenOrders.add(qu.orderId);
        trackingByQuoteId.set(qu.id, conts);
      }
    }
  }

  // Desktop table groups quotes under their order: an order header row (which
  // carries the shipment tracker) followed by that order's quote rows. A group
  // appears at the position of its first quote in the current list; quotes with
  // no order render as standalone rows. (Mobile keeps the flat card layout.)
  const orderGroups = [];
  {
    const byOrder = new Map();
    for (const qu of filtered) {
      const ord = qu.orderId ? ordersById.get(qu.orderId) : null;
      if (!ord) continue;
      if (!byOrder.has(ord.id)) byOrder.set(ord.id, []);
      byOrder.get(ord.id).push(qu);
    }
    const emitted = new Set();
    for (const qu of filtered) {
      const ord = qu.orderId ? ordersById.get(qu.orderId) : null;
      if (ord) {
        if (emitted.has(ord.id)) continue;
        emitted.add(ord.id);
        orderGroups.push({ type: 'group', order: ord, quotes: byOrder.get(ord.id) });
      } else {
        orderGroups.push({ type: 'quote', quote: qu });
      }
    }
  }

  return {
    scopedCount: scopedQuotes.length,
    tabs,
    creatorFilter,
    rows: filtered,
    orderGroups,
    trackingByQuoteId,
    totalByQuoteId,
    customerById,
    profileById,
    ordersById,
    trackableByOrderId,
  };
}

// ViewModel for pages/Orders.jsx. Pure projection off the raw rows: the
// customer label each order shows, plus the per-order rollups (total, quote
// count, container count) the list reads straight through.
export function resolveOrdersList({ orders, customers, quotes, containers, lines }) {
  const customerById = new Map();
  for (const c of customers) customerById.set(c.id, c);

  // For each order, build the set of customer rows attached via its
  // quotes. Many orders are created from a quote (the OrderChip flow
  // pre-sets order.customerId), but some are created manually via
  // "Nuevo pedido" and never have a direct customer — they inherit
  // their customer from whichever quote(s) are attached. Without this
  // lookup the Pedidos list rendered "Sin cliente" for those orders,
  // which read as a data problem when it was just a display gap.
  const customersByOrder = new Map();
  for (const q of quotes) {
    if (!q.orderId || !q.customerId) continue;
    const customer = customerById.get(q.customerId);
    if (!customer) continue;
    if (!customersByOrder.has(q.orderId)) customersByOrder.set(q.orderId, []);
    const list = customersByOrder.get(q.orderId);
    if (!list.some((c) => c.id === customer.id)) list.push(customer);
  }

  // Resolve the customer label for an order: prefer the direct
  // assignment (order.customerId), fall back to the quotes', cap
  // visible at the first customer plus "+N más" when several. Precomputed
  // into a Map so the View just reads a string per order.
  const customerLabelByOrderId = new Map();
  for (const o of orders) {
    const direct = o.customerId ? customerById.get(o.customerId) : null;
    if (direct) {
      customerLabelByOrderId.set(o.id, direct.company || direct.name);
      continue;
    }
    const fromQuotes = customersByOrder.get(o.id) || [];
    if (fromQuotes.length === 0) {
      customerLabelByOrderId.set(o.id, null);
      continue;
    }
    const head = fromQuotes[0].company || fromQuotes[0].name;
    customerLabelByOrderId.set(
      o.id,
      fromQuotes.length === 1 ? head : `${head} + ${fromQuotes.length - 1} más`,
    );
  }

  // Group lines by quote, then run each quote through the canonical
  // computeTotals so compounds (qty/unitPrice=0 by design) roll up
  // their components and line-level + quote-level adjustments
  // (discount, ITBIS, shipping) land in the figure. Previously the
  // inline `qty * unitPrice` math showed $0 for compound quotes and
  // ignored every adjustment.
  const linesByQuote = linesByQuoteId(lines);
  const totalByOrder = new Map();
  const quoteCountByOrder = new Map();
  for (const q of quotes) {
    if (!q.orderId) continue;
    const t = quoteGrandTotal(q, linesByQuote.get(q.id) || []);
    totalByOrder.set(q.orderId, (totalByOrder.get(q.orderId) || 0) + t);
    quoteCountByOrder.set(q.orderId, (quoteCountByOrder.get(q.orderId) || 0) + 1);
  }
  const containerCountByOrder = new Map();
  for (const c of containers) {
    if (!c.orderId) continue;
    containerCountByOrder.set(c.orderId, (containerCountByOrder.get(c.orderId) || 0) + 1);
  }

  return {
    customerLabelByOrderId,
    totalByOrder,
    quoteCountByOrder,
    containerCountByOrder,
  };
}
