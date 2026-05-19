import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Mail, Phone, MapPin, Pencil, ExternalLink, FileText, Package,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import CustomerModal from '../components/CustomerModal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import StatCard from '../components/StatCard.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { computeTotals, lineForTotals } from '../lib/pricing.js';
import { ORDER_STAGE_BY_KEY, currentOrderStage } from '../lib/orderStages.js';

/**
 * One customer's detail view — the dealer asked for the customer card
 * to "reveal their related documents". This page is what a click on
 * a row in the Customers list opens: the customer's contact card up
 * top, then everything the customer is on file for — every cotización
 * tied to them (grouped by status) and every pedido (grouped by
 * lifecycle stage). The Customers list itself stays purely the
 * address-book view; this is where the relationship history lives.
 *
 * Mirrors the structure of ProfessionalDetail.jsx — same header
 * pattern, same status-grouping pattern — so dealers who already know
 * one screen learn the other for free.
 */

const QUOTE_STATUS_ORDER = ['accepted', 'sent', 'draft', 'declined', 'archived'];
const QUOTE_STATUS_LABELS = {
  draft: 'Borradores',
  sent: 'Enviadas',
  accepted: 'Aceptadas',
  declined: 'Rechazadas',
  archived: 'Archivadas',
};

const ORDER_STAGE_ORDER = [
  'received', 'in_customs', 'in_transit', 'confirmed', 'placed', 'draft', 'cancelled',
];

export default function CustomerDetail() {
  const { customerId } = useParams();
  const { profileId } = useApp();
  const navigate = useNavigate();
  // Local state for the edit modal. The same CustomerModal the list
  // page uses opens here too — passing onAfterDelete navigates back
  // to /customers so the user doesn't get stuck on a "Cargando
  // cliente…" stub after deleting the row they were just looking at.
  const [editing, setEditing] = useState(null);

  const customer = useLiveQuery(
    () => db.customers.get(customerId),
    [customerId],
    null,
  );

  // Quotes attached to this customer. We deliberately don't filter by
  // status here — the per-status grouping below handles that — so a
  // declined or archived quote still shows up in the history view.
  const { data: quotes, loaded: quotesLoaded } = useLiveQueryStatus(
    () => db.quotes.where('customerId').equals(customerId).toArray(),
    [customerId],
    [],
  );

  // Orders. Direct match on order.customerId picks up orders the
  // dealer assigned explicitly. We also derive customer assignments
  // from the attached quotes: if a quote on an order has this
  // customer, the order is part of this customer's history even if
  // order.customerId is null (which is the common case for manually-
  // created orders that take their customer from their first quote).
  const { data: allOrders, loaded: ordersLoaded } = useLiveQueryStatus(
    () => db.orders.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  // Lines drive the grand-total roll-up per quote.
  const { data: allLines, loaded: linesLoaded } = useLiveQueryStatus(
    () => db.quoteLines.toArray(),
    [],
    [],
  );

  const loaded = quotesLoaded && ordersLoaded && linesLoaded;

  const derived = useMemo(() => {
    const linesByQuote = new Map();
    for (const ln of allLines) {
      if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
      linesByQuote.get(ln.quoteId).push(ln);
    }
    function totalFor(q) {
      const rows = (linesByQuote.get(q.id) || [])
        .filter((l) => l.kind !== 'section')
        .map(lineForTotals);
      return computeTotals(rows, q).grandTotal;
    }

    // Per-quote total + grouping by status.
    const totalByQuote = new Map();
    const quotesByStatus = new Map();
    for (const q of quotes) {
      totalByQuote.set(q.id, totalFor(q));
      const key = q.status || 'draft';
      if (!quotesByStatus.has(key)) quotesByStatus.set(key, []);
      quotesByStatus.get(key).push(q);
    }
    for (const arr of quotesByStatus.values()) {
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    // Orders related to this customer: direct match OR any quote of
    // theirs is attached. The relevant-order Set holds order ids that
    // qualify; we then pull the full order rows for rendering.
    const customerQuoteIds = new Set(quotes.map((q) => q.id));
    const relevantOrderIds = new Set();
    for (const o of allOrders) {
      if (o.customerId === customerId) relevantOrderIds.add(o.id);
    }
    for (const q of quotes) {
      if (q.orderId) relevantOrderIds.add(q.orderId);
    }
    const orders = allOrders.filter((o) => relevantOrderIds.has(o.id));
    // Sort orders by stage progression (received last → draft first
    // would be weird; do the opposite: in-flight first, archived last).
    orders.sort((a, b) => {
      const ai = ORDER_STAGE_ORDER.indexOf(a.status);
      const bi = ORDER_STAGE_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    // Roll-ups: accepted-quotes value, all-time value.
    const acceptedTotal = (quotesByStatus.get('accepted') || [])
      .reduce((s, q) => s + (totalByQuote.get(q.id) || 0), 0);
    const allTimeTotal = quotes
      .reduce((s, q) => s + (totalByQuote.get(q.id) || 0), 0);

    return {
      totalByQuote,
      quotesByStatus,
      orders,
      acceptedTotal,
      allTimeTotal,
      customerQuoteIds,
    };
  }, [quotes, allOrders, allLines, customerId]);

  if (!customer) {
    return (
      <div className="card card-pad text-center text-sm text-ink-500">
        Cargando cliente…
      </div>
    );
  }

  return (
    <>
      <Link
        to="/customers"
        className="back-link"
      >
        <ArrowLeft size={12} /> Volver a clientes
      </Link>

      <PageHeader
        title={customer.name || 'Cliente'}
        subtitle={customer.company || ' '}
        actions={
          <button
            type="button"
            onClick={() => setEditing(customer)}
            className="btn-secondary"
            title="Editar cliente"
          >
            <Pencil size={14} /> Editar
          </button>
        }
      />

      <CustomerModal
        customer={editing}
        onClose={() => setEditing(null)}
        onAfterDelete={() => navigate('/customers')}
        profileId={profileId}
      />

      <ContactCard customer={customer} />

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard
          label="Cotizaciones"
          value={loaded ? String(quotes.length) : '—'}
          hint={loaded ? (quotes.length === 1 ? 'cotización en total' : 'cotizaciones en total') : 'Cargando…'}
          tone="ink"
        />
        <StatCard
          label="Comprometido"
          value={loaded ? formatMoney(derived.acceptedTotal, 'USD', { USD: 1 }) : '—'}
          hint="Solo cotizaciones aceptadas"
          tone="emerald"
          accent
        />
        <StatCard
          label="Pedidos"
          value={loaded ? String(derived.orders.length) : '—'}
          hint={loaded
            ? (derived.orders.length === 1 ? 'pedido en historial' : 'pedidos en historial')
            : 'Cargando…'}
          tone="ink"
          accent
        />
      </div>

      {/* Quotes — grouped by status */}
      <section className="card overflow-hidden mb-5">
        <header className="card-header">
          <h2 className="flex items-center gap-2">
            <FileText size={14} className="text-ink-500" />
            Cotizaciones
          </h2>
        </header>
        {!loaded ? (
          <div className="px-5 py-6 text-center text-sm text-ink-500">Cargando…</div>
        ) : quotes.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            Sin cotizaciones para este cliente.
          </div>
        ) : (
          <div className="divide-y divide-ink-100">
            {QUOTE_STATUS_ORDER.map((status) => {
              const list = derived.quotesByStatus.get(status);
              if (!list || list.length === 0) return null;
              const total = list.reduce((s, q) => s + (derived.totalByQuote.get(q.id) || 0), 0);
              return (
                <div key={status} className="px-5 py-3">
                  <div className="flex items-baseline justify-between gap-2 mb-2">
                    <span className={`status-pill status-pill-${status}`}>
                      {QUOTE_STATUS_LABELS[status] || 'Borrador'}
                    </span>
                    <span className="text-[11px] text-ink-500 tabular-nums">
                      {list.length} · {formatMoney(total, 'USD', { USD: 1 })}
                    </span>
                  </div>
                  <ul className="divide-y divide-ink-100">
                    {list.map((q) => (
                      <li key={q.id}>
                        <Link
                          to={`/quotes/${q.id}`}
                          className="flex items-center gap-3 px-2 py-2 -mx-2 hover:bg-ink-50 rounded transition-colors"
                        >
                          <div className="text-sm font-medium tabular-nums w-16 flex-shrink-0">
                            #{q.number || '—'}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] text-ink-500 truncate">
                              Act. {formatDateTime(q.updatedAt)}
                            </div>
                          </div>
                          <div className="text-sm font-medium tabular-nums whitespace-nowrap">
                            {formatMoney(derived.totalByQuote.get(q.id) || 0, q.currencyCode || 'USD', q.rates || { USD: 1 })}
                          </div>
                          <ExternalLink size={12} className="text-ink-300 flex-shrink-0" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Orders */}
      <section className="card overflow-hidden">
        <header className="card-header">
          <h2 className="flex items-center gap-2">
            <Package size={14} className="text-ink-500" />
            Pedidos
          </h2>
        </header>
        {!loaded ? (
          <div className="px-5 py-6 text-center text-sm text-ink-500">Cargando…</div>
        ) : derived.orders.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            Aún no hay pedidos para este cliente.
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {derived.orders.map((o) => {
              const stage = ORDER_STAGE_BY_KEY[currentOrderStage(o)];
              return (
                <li key={o.id}>
                  <Link
                    to={`/orders/${o.id}`}
                    className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors"
                  >
                    <div className="text-sm font-medium tabular-nums w-16 flex-shrink-0">
                      #{o.number || '—'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {stage?.label || 'Borrador'}
                      </div>
                      <div className="text-[11px] text-ink-500 truncate">
                        Act. {formatDateTime(o.updatedAt)}
                      </div>
                    </div>
                    <ExternalLink size={12} className="text-ink-300 flex-shrink-0" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function ContactCard({ customer }) {
  // Compact contact block — only renders rows that have data, so a
  // bare customer record (just name) doesn't leave a wall of "—".
  const addr = [
    customer.address,
    [customer.city, customer.state, customer.zip].filter(Boolean).join(', '),
    customer.country,
  ].filter(Boolean).join(' · ');

  if (!customer.email && !customer.phone && !addr && !customer.notes) {
    return null;
  }
  return (
    <div className="card card-pad mb-5 text-sm space-y-1.5">
      {customer.email && (
        <div className="flex items-center gap-2">
          <Mail size={14} className="text-ink-400 flex-shrink-0" />
          <a href={`mailto:${customer.email}`} className="text-ink-700 hover:text-brand-700 truncate">
            {customer.email}
          </a>
        </div>
      )}
      {customer.phone && (
        <div className="flex items-center gap-2">
          <Phone size={14} className="text-ink-400 flex-shrink-0" />
          <a href={`tel:${customer.phone}`} className="text-ink-700 hover:text-brand-700">
            {customer.phone}
          </a>
        </div>
      )}
      {addr && (
        <div className="flex items-start gap-2">
          <MapPin size={14} className="text-ink-400 flex-shrink-0 mt-0.5" />
          <div className="text-ink-700">{addr}</div>
        </div>
      )}
      {customer.notes && (
        <p className="text-ink-500 pt-1 whitespace-pre-wrap text-xs">{customer.notes}</p>
      )}
    </div>
  );
}

