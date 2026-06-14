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
import { SCOPE_TEAM } from '../../../lib/constants.js';
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
  quotes, customers, professionals, profiles, orders, containers, lines,
  scope, meId, q, tab, filters, sort,
}) {
  const customerById = new Map();
  for (const c of customers) customerById.set(c.id, c);

  const professionalById = new Map();
  for (const p of professionals || []) professionalById.set(p.id, p);

  // Profiles include the shared 'team' settings row alongside real
  // users; the lookup is keyed by auth.uid() so we hit only the
  // matching employee on each quote.createdByUserId reference.
  const profileById = new Map();
  for (const p of profiles) profileById.set(p.id, p);

  const ordersById = new Map();
  for (const o of orders) ordersById.set(o.id, o);

  // Per-quote CLIENT label for the "Cliente" column: the assigned customer's
  // name, or — when NO customer is set — the PROFESSIONAL's name (flagged), so a
  // clientless quote still identifies who the work is for. `isProfessional` lets
  // the row mark the fallback; null ⇒ neither on file ("Sin cliente"). One map
  // drives the column, its sort, and the search needle so they never disagree.
  const clientByQuoteId = new Map();
  for (const qu of quotes) {
    const cust = customerById.get(qu.customerId);
    if (cust) {
      clientByQuoteId.set(qu.id, { name: cust.name || cust.company || '', isProfessional: false });
      continue;
    }
    const prof = professionalById.get(qu.professionalId);
    if (prof) clientByQuoteId.set(qu.id, { name: prof.name || prof.company || '', isProfessional: true });
  }

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
      // Match the professional too, so searching a clientless quote by the
      // referrer's name (what the row now shows) finds it.
      const prof = professionalById.get(qu.professionalId);
      return (
        (qu.number || '').toString().includes(needle) ||
        (cust?.name || '').toLowerCase().includes(needle) ||
        (cust?.company || '').toLowerCase().includes(needle) ||
        (prof?.name || '').toLowerCase().includes(needle)
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
      // Sort by the label actually shown (customer, or professional fallback).
      const an = (clientByQuoteId.get(a.id)?.name || '').toLowerCase();
      const bn = (clientByQuoteId.get(b.id)?.name || '').toLowerCase();
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
    professionalById,
    clientByQuoteId,
    profileById,
    ordersById,
    trackableByOrderId,
  };
}

// Status display order for the per-professional quote dropdown — committed
// first, then the live pipeline, then the dead/parked statuses. Mirrors the
// section order on ProfessionalDetail so the two surfaces read the same way.
export const PROFESSIONAL_QUOTE_STATUS_ORDER = ['accepted', 'sent', 'draft', 'declined', 'archived'];

// ViewModel for pages/Professionals.jsx — the whole searchable directory.
// Pure projection: the page passes the raw rows plus its resolved state
// (q / tab / filters / sort) and reads everything straight through:
//   rollupByProfessionalId — per-professional quote rollup for the dropdown:
//     ordered status groups (quote + customer + grand total per entry), the
//     count / all-time / accepted figures, last quote activity, and the
//     contact-gap flags that drive the maintenance views.
//   tabs       — primary "saved views" strip with counts (activity + data
//                completeness dimensions), counted off ALL professionals so
//                each tab reads "how many would I see if I tapped this".
//   filterDefs — secondary-filter config for the FilterBar pills
//                (empresa, datos de contacto, última cotización, alta).
//   rows       — the professionals that survive tab + filters + search, in
//                sort order.
// Money routes through the shared totals helpers so these figures agree to
// the cent with ProfessionalDetail and the quotes list.
export function resolveProfessionalsList({
  professionals, quotes, lines, customers,
  q = '', tab = 'all', filters = {}, sort = { key: 'name', dir: 'asc' },
}) {
  const customerById = new Map();
  for (const c of customers || []) customerById.set(c.id, c);

  // Quotes bucketed by their assigned professional (unassigned quotes simply
  // don't appear on this page).
  const quotesByPro = new Map();
  for (const qu of quotes || []) {
    if (!qu.professionalId) continue;
    if (!quotesByPro.has(qu.professionalId)) quotesByPro.set(qu.professionalId, []);
    quotesByPro.get(qu.professionalId).push(qu);
  }

  const pros = professionals || [];
  const linesByQuote = linesByQuoteId(lines);
  const rollupByProfessionalId = new Map();
  for (const p of pros) {
    const qs = quotesByPro.get(p.id) || [];
    const byStatus = new Map();
    let allTimeTotal = 0;
    let acceptedTotal = 0;
    let lastActivityAt = 0;
    for (const qu of qs) {
      const total = quoteGrandTotal(qu, linesByQuote.get(qu.id) || []);
      const status = qu.status || 'draft';
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push({
        quote: qu,
        customer: qu.customerId ? customerById.get(qu.customerId) : null,
        total,
      });
      allTimeTotal += total;
      if (status === 'accepted') acceptedTotal += total;
      if ((qu.updatedAt || 0) > lastActivityAt) lastActivityAt = qu.updatedAt || 0;
    }
    // Ordered, non-empty groups; freshest deal first inside each group.
    const groups = [];
    for (const status of PROFESSIONAL_QUOTE_STATUS_ORDER) {
      const entries = byStatus.get(status);
      if (!entries || entries.length === 0) continue;
      entries.sort((a, b) => (b.quote.updatedAt || 0) - (a.quote.updatedAt || 0));
      groups.push({ status, entries });
    }
    // Contact gaps drive the "Datos incompletos" tab, the contact filter and
    // the row-level warning dot — one definition so they can never disagree.
    const missingEmail = !String(p.email || '').trim();
    const missingPhone = !String(p.phone || '').trim();
    rollupByProfessionalId.set(p.id, {
      count: qs.length,
      groups,
      allTimeTotal,
      acceptedTotal,
      lastActivityAt,
      missingEmail,
      missingPhone,
      incomplete: missingEmail || missingPhone,
    });
  }

  // Primary tabs: pipeline activity + data completeness. Counts off the full
  // directory, independent of search/filters (same convention as Quotes).
  let activeN = 0;
  let wonN = 0;
  let idleN = 0;
  let incompleteN = 0;
  for (const p of pros) {
    const r = rollupByProfessionalId.get(p.id);
    if (r.count > 0) activeN += 1;
    else idleN += 1;
    if (r.acceptedTotal > 0) wonN += 1;
    if (r.incomplete) incompleteN += 1;
  }
  const tabs = [
    { key: 'all', label: 'Todos', count: pros.length },
    { key: 'active', label: 'Con cotizaciones', count: activeN },
    { key: 'won', label: 'Con ventas', count: wonN },
    { key: 'idle', label: 'Sin actividad', count: idleN },
    { key: 'incomplete', label: 'Datos incompletos', count: incompleteN },
  ];

  const filterDefs = [
    {
      key: 'contact',
      label: 'Datos de contacto',
      type: 'select',
      placeholder: 'Todos',
      options: [
        { value: 'sin-correo', label: 'Sin correo' },
        { value: 'sin-telefono', label: 'Sin teléfono' },
        { value: 'incompleto', label: 'Faltan datos' },
        { value: 'completo', label: 'Contacto completo' },
      ],
    },
    { key: 'activity', label: 'Última cotización', type: 'date-range' },
  ];

  // Date-range filters arrive as {from,to} 'YYYY-MM-DD' strings; widen the
  // "hasta" bound to end-of-day so picking the same day on both ends works.
  const parseRange = (r) => ({
    from: r?.from ? Date.parse(`${r.from}T00:00:00`) : null,
    to: r?.to ? Date.parse(`${r.to}T23:59:59.999`) : null,
  });
  const activity = parseRange(filters.activity);

  const needle = String(q || '').trim().toLowerCase();
  // Digit-only view of the needle so a phone search hits regardless of how
  // the number was typed/stored ("809-555…" finds "8095 55…").
  const needleDigits = needle.replace(/\D/g, '');

  const matched = pros.filter((p) => {
    const r = rollupByProfessionalId.get(p.id);
    if (tab === 'active' && r.count === 0) return false;
    if (tab === 'won' && r.acceptedTotal <= 0) return false;
    if (tab === 'idle' && r.count > 0) return false;
    if (tab === 'incomplete' && !r.incomplete) return false;

    if (filters.contact === 'sin-correo' && !r.missingEmail) return false;
    if (filters.contact === 'sin-telefono' && !r.missingPhone) return false;
    if (filters.contact === 'incompleto' && !r.incomplete) return false;
    if (filters.contact === 'completo' && r.incomplete) return false;

    // Activity range only matches professionals who HAVE activity — a pro
    // with no quotes can't fall inside any date window.
    if (activity.from != null || activity.to != null) {
      if (!r.lastActivityAt) return false;
      if (activity.from != null && r.lastActivityAt < activity.from) return false;
      if (activity.to != null && r.lastActivityAt > activity.to) return false;
    }

    if (!needle) return true;
    const corpus = [
      p.name, p.company, p.email, p.phone, p.address, p.notes,
      p.number != null ? `#${p.number}` : '',
    ].map((s) => String(s || '').toLowerCase()).join(' ');
    if (corpus.includes(needle)) return true;
    if (needleDigits.length >= 3) {
      const phoneDigits = String(p.phone || '').replace(/\D/g, '');
      if (phoneDigits.includes(needleDigits)) return true;
    }
    return false;
  });

  const mul = sort.dir === 'asc' ? 1 : -1;
  const rows = [...matched].sort((a, b) => {
    const ra = rollupByProfessionalId.get(a.id);
    const rb = rollupByProfessionalId.get(b.id);
    if (sort.key === 'quotes') return (ra.count - rb.count) * mul;
    if (sort.key === 'sales') return (ra.acceptedTotal - rb.acceptedTotal) * mul;
    if (sort.key === 'activity') return (ra.lastActivityAt - rb.lastActivityAt) * mul;
    if (sort.key === 'created') return ((a.createdAt || 0) - (b.createdAt || 0)) * mul;
    if (sort.key === 'company') {
      return String(a.company || '').toLowerCase()
        .localeCompare(String(b.company || '').toLowerCase()) * mul;
    }
    return String(a.name || '').toLowerCase()
      .localeCompare(String(b.name || '').toLowerCase()) * mul;
  });

  return { rollupByProfessionalId, rows, tabs, filterDefs, totalCount: pros.length };
}

// ViewModel for pages/Customers.jsx — the seller-facing client directory.
// Same projection contract as resolveProfessionalsList (raw rows + resolved
// q/tab/filters/sort in; rollups, tabs, filterDefs and the result rows out),
// but the dimensions are the ones a SELLER works by:
//   • Pipeline abierto — clients with a live draft/sent quote: the follow-up
//     list, with openTotal so the biggest deals on the table surface first.
//   • Con compras — clients with accepted quotes (lifetime value): who has
//     actually bought, for repeat business and preferential treatment.
//   • Sin actividad — on file but never quoted: the outreach pool.
//   • Datos incompletos — no email or phone: unreachable, fix before selling.
//   • Fiscal (RNC) — a B01 e-CF needs the client's RNC; the filter shows who
//     still needs it collected before invoicing.
// Money routes through the shared totals helpers so figures agree to the
// cent with CustomerDetail, the quotes list and the dashboard.
export function resolveCustomersList({
  customers, quotes, lines,
  q = '', tab = 'all', filters = {}, sort = { key: 'name', dir: 'asc' },
}) {
  const quotesByCustomer = new Map();
  for (const qu of quotes || []) {
    if (!qu.customerId) continue;
    if (!quotesByCustomer.has(qu.customerId)) quotesByCustomer.set(qu.customerId, []);
    quotesByCustomer.get(qu.customerId).push(qu);
  }

  const rows0 = customers || [];
  const linesByQuote = linesByQuoteId(lines);
  const rollupByCustomerId = new Map();
  for (const c of rows0) {
    const qs = quotesByCustomer.get(c.id) || [];
    const byStatus = new Map();
    let openCount = 0;
    let openTotal = 0;
    let acceptedTotal = 0;
    let lastActivityAt = 0;
    for (const qu of qs) {
      const total = quoteGrandTotal(qu, linesByQuote.get(qu.id) || []);
      const status = qu.status || 'draft';
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push({ quote: qu, total });
      // "Open pipeline" = quotes still in play (draft or sent) — the deals a
      // seller can still move; accepted/declined/archived are settled.
      if (status === 'draft' || status === 'sent') {
        openCount += 1;
        openTotal += total;
      }
      if (status === 'accepted') acceptedTotal += total;
      if ((qu.updatedAt || 0) > lastActivityAt) lastActivityAt = qu.updatedAt || 0;
    }
    const groups = [];
    for (const status of PROFESSIONAL_QUOTE_STATUS_ORDER) {
      const entries = byStatus.get(status);
      if (!entries || entries.length === 0) continue;
      entries.sort((a, b) => (b.quote.updatedAt || 0) - (a.quote.updatedAt || 0));
      groups.push({ status, entries });
    }
    const missingEmail = !String(c.email || '').trim();
    const missingPhone = !String(c.phone || '').trim();
    rollupByCustomerId.set(c.id, {
      count: qs.length,
      groups,
      openCount,
      openTotal,
      acceptedTotal,
      lastActivityAt,
      missingEmail,
      missingPhone,
      incomplete: missingEmail || missingPhone,
      hasRnc: !!String(c.rnc || '').trim(),
    });
  }

  let pipelineN = 0;
  let buyersN = 0;
  let idleN = 0;
  let incompleteN = 0;
  for (const c of rows0) {
    const r = rollupByCustomerId.get(c.id);
    if (r.openCount > 0) pipelineN += 1;
    if (r.acceptedTotal > 0) buyersN += 1;
    if (r.count === 0) idleN += 1;
    if (r.incomplete) incompleteN += 1;
  }
  const tabs = [
    { key: 'all', label: 'Todos', count: rows0.length },
    { key: 'pipeline', label: 'Pipeline abierto', count: pipelineN },
    { key: 'buyers', label: 'Con compras', count: buyersN },
    { key: 'idle', label: 'Sin actividad', count: idleN },
    { key: 'incomplete', label: 'Datos incompletos', count: incompleteN },
  ];

  // Ciudad options: distinct non-empty cities actually on file — sellers
  // plan deliveries and visits by city, and the dropdown never lists a city
  // nobody lives in.
  const citySeen = new Map();
  for (const c of rows0) {
    const raw = String(c.city || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!citySeen.has(key)) citySeen.set(key, raw);
  }
  const filterDefs = [
    {
      key: 'city',
      label: 'Ciudad',
      type: 'select',
      placeholder: 'Todas',
      options: [...citySeen.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
    {
      key: 'contact',
      label: 'Datos de contacto',
      type: 'select',
      placeholder: 'Todos',
      options: [
        { value: 'sin-correo', label: 'Sin correo' },
        { value: 'sin-telefono', label: 'Sin teléfono' },
        { value: 'incompleto', label: 'Faltan datos' },
        { value: 'completo', label: 'Contacto completo' },
      ],
    },
    {
      key: 'fiscal',
      label: 'Fiscal',
      type: 'select',
      placeholder: 'Todos',
      options: [
        { value: 'con-rnc', label: 'Con RNC' },
        { value: 'sin-rnc', label: 'Sin RNC' },
      ],
    },
    { key: 'activity', label: 'Última cotización', type: 'date-range' },
    { key: 'created', label: 'Fecha de alta', type: 'date-range' },
  ];

  const parseRange = (r) => ({
    from: r?.from ? Date.parse(`${r.from}T00:00:00`) : null,
    to: r?.to ? Date.parse(`${r.to}T23:59:59.999`) : null,
  });
  const activity = parseRange(filters.activity);
  const created = parseRange(filters.created);

  const needle = String(q || '').trim().toLowerCase();
  const needleDigits = needle.replace(/\D/g, '');

  const matched = rows0.filter((c) => {
    const r = rollupByCustomerId.get(c.id);
    if (tab === 'pipeline' && r.openCount === 0) return false;
    if (tab === 'buyers' && r.acceptedTotal <= 0) return false;
    if (tab === 'idle' && r.count > 0) return false;
    if (tab === 'incomplete' && !r.incomplete) return false;

    if (filters.city && String(c.city || '').trim().toLowerCase() !== filters.city) return false;
    if (filters.contact === 'sin-correo' && !r.missingEmail) return false;
    if (filters.contact === 'sin-telefono' && !r.missingPhone) return false;
    if (filters.contact === 'incompleto' && !r.incomplete) return false;
    if (filters.contact === 'completo' && r.incomplete) return false;
    if (filters.fiscal === 'con-rnc' && !r.hasRnc) return false;
    if (filters.fiscal === 'sin-rnc' && r.hasRnc) return false;

    if (activity.from != null || activity.to != null) {
      if (!r.lastActivityAt) return false;
      if (activity.from != null && r.lastActivityAt < activity.from) return false;
      if (activity.to != null && r.lastActivityAt > activity.to) return false;
    }
    if (created.from != null && (c.createdAt || 0) < created.from) return false;
    if (created.to != null && (c.createdAt || 0) > created.to) return false;

    if (!needle) return true;
    const corpus = [
      c.name, c.company, c.contactName, c.email, c.phone,
      c.rnc, c.address, c.city, c.notes,
    ].map((s) => String(s || '').toLowerCase()).join(' ');
    if (corpus.includes(needle)) return true;
    if (needleDigits.length >= 3) {
      const phoneDigits = String(c.phone || '').replace(/\D/g, '');
      if (phoneDigits.includes(needleDigits)) return true;
    }
    return false;
  });

  const mul = sort.dir === 'asc' ? 1 : -1;
  const rows = [...matched].sort((a, b) => {
    const ra = rollupByCustomerId.get(a.id);
    const rb = rollupByCustomerId.get(b.id);
    if (sort.key === 'pipeline') return (ra.openTotal - rb.openTotal) * mul;
    if (sort.key === 'lifetime') return (ra.acceptedTotal - rb.acceptedTotal) * mul;
    if (sort.key === 'activity') return (ra.lastActivityAt - rb.lastActivityAt) * mul;
    if (sort.key === 'created') return ((a.createdAt || 0) - (b.createdAt || 0)) * mul;
    if (sort.key === 'company') {
      return String(a.company || '').toLowerCase()
        .localeCompare(String(b.company || '').toLowerCase()) * mul;
    }
    return String(a.name || '').toLowerCase()
      .localeCompare(String(b.name || '').toLowerCase()) * mul;
  });

  return { rollupByCustomerId, rows, tabs, filterDefs, totalCount: rows0.length };
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
