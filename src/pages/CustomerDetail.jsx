import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Mail, Phone, MapPin, Pencil, ExternalLink, FileText, Package, User,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import CustomerModal from '../components/CustomerModal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ListLoading from '../components/ListLoading.jsx';
import StatCard from '../components/StatCard.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { ORDER_STAGE_BY_KEY, currentOrderStage } from '../lib/orderStages.js';
import { resolveCustomerDetail } from '../core/quote/views/detail.js';

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

  // The ViewModel: per-quote totals, the quotes grouped (and sorted) by
  // status, the related orders (direct customerId match OR any of the
  // customer's quotes is attached, sorted by stage), and the committed /
  // all-time value roll-ups. The page renders straight from this.
  const derived = useMemo(
    () => resolveCustomerDetail({
      customerId,
      quotes,
      orders: allOrders,
      lines: allLines,
    }),
    [quotes, allOrders, allLines, customerId],
  );

  if (!customer) {
    return (
      <div className="card card-pad py-16 flex flex-col items-center gap-3 text-center">
        <span className="w-11 h-11 rounded-full bg-ink-50 flex items-center justify-center">
          <User size={20} className="text-ink-300" />
        </span>
        <p className="text-sm text-ink-500">Cargando cliente…</p>
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
            <span className="w-7 h-7 rounded-lg bg-brand-50 text-brand-700 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0">
              <FileText size={13} />
            </span>
            Cotizaciones
          </h2>
        </header>
        {!loaded ? (
          <ListLoading rows={3} dense />
        ) : quotes.length === 0 ? (
          <div className="px-5 py-14 flex flex-col items-center gap-3 text-center">
            <span className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center">
              <FileText size={22} className="text-brand-400" />
            </span>
            <div>
              <p className="text-sm font-medium text-ink-700">Sin cotizaciones</p>
              <p className="text-xs text-ink-400 mt-0.5">Aún no hay cotizaciones vinculadas a este cliente.</p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-ink-100">
            {QUOTE_STATUS_ORDER.map((status) => {
              const list = derived.quotesByStatus.get(status);
              if (!list || list.length === 0) return null;
              const total = list.reduce((s, q) => s + (derived.totalByQuote.get(q.id) || 0), 0);
              return (
                <div key={status} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`status-pill status-pill-${status}`}>
                        {QUOTE_STATUS_LABELS[status] || 'Borrador'}
                      </span>
                      <span className="eyebrow-xs text-ink-400 tabular-nums">{list.length}</span>
                    </div>
                    <span className="text-[11px] font-medium text-ink-600 tabular-nums">
                      {formatMoney(total, 'USD', { USD: 1 })}
                    </span>
                  </div>
                  <ul className="divide-y divide-ink-100">
                    {list.map((q) => (
                      <li key={q.id}>
                        <Link
                          to={`/quotes/${q.id}`}
                          className="group flex items-center gap-3 px-2 py-3 -mx-2 rounded-md hover:bg-brand-50/60 hover:shadow-xs active:scale-[0.99] transition-all duration-150"
                        >
                          <div className="text-sm font-semibold tabular-nums w-16 flex-shrink-0 text-ink-800 group-hover:text-brand-700 transition-colors">
                            #{q.number || '—'}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] text-ink-500 truncate">
                              Act. {formatDateTime(q.updatedAt)}
                            </div>
                          </div>
                          <div className="text-sm font-semibold tabular-nums whitespace-nowrap text-ink-900">
                            {formatMoney(derived.totalByQuote.get(q.id) || 0, q.currencyCode || 'USD', q.rates || { USD: 1 })}
                          </div>
                          <ExternalLink size={12} className="text-ink-300 group-hover:text-brand-500 flex-shrink-0 transition-colors" />
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
            <span className="w-7 h-7 rounded-lg bg-ink-100 text-ink-600 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0">
              <Package size={13} />
            </span>
            Pedidos
          </h2>
        </header>
        {!loaded ? (
          <ListLoading rows={3} dense />
        ) : derived.orders.length === 0 ? (
          <div className="px-5 py-14 flex flex-col items-center gap-3 text-center">
            <span className="w-12 h-12 rounded-full bg-ink-50 flex items-center justify-center">
              <Package size={22} className="text-ink-300" />
            </span>
            <div>
              <p className="text-sm font-medium text-ink-700">Sin pedidos</p>
              <p className="text-xs text-ink-400 mt-0.5">Aún no hay pedidos para este cliente.</p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {derived.orders.map((o) => {
              const stage = ORDER_STAGE_BY_KEY[currentOrderStage(o)];
              return (
                <li key={o.id}>
                  <Link
                    to={`/orders/${o.id}`}
                    className="group flex items-center gap-3 px-5 py-3.5 hover:bg-brand-50/60 hover:shadow-xs active:scale-[0.99] transition-all duration-150"
                  >
                    <div className="text-sm font-semibold tabular-nums w-16 flex-shrink-0 text-ink-800 group-hover:text-brand-700 transition-colors">
                      #{o.number || '—'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink-800 truncate">
                        {stage?.label || 'Borrador'}
                      </div>
                      <div className="text-[11px] text-ink-500 truncate">
                        Act. {formatDateTime(o.updatedAt)}
                      </div>
                    </div>
                    <ExternalLink size={12} className="text-ink-300 group-hover:text-brand-500 flex-shrink-0 transition-colors" />
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

  if (!customer.contactName && !customer.email && !customer.phone && !addr && !customer.notes) {
    return null;
  }
  return (
    <div className="card overflow-hidden mb-5">
      <div className="card-pad space-y-2.5 text-sm">
        {customer.contactName && (
          <div className="flex items-center gap-2.5">
            <span className="w-6 h-6 rounded-md bg-brand-50 text-brand-600 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0">
              <User size={12} />
            </span>
            <span className="text-ink-800 font-medium">{customer.contactName}</span>
          </div>
        )}
        {customer.email && (
          <div className="flex items-center gap-2.5">
            <span className="w-6 h-6 rounded-md bg-ink-100 text-ink-500 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0">
              <Mail size={12} />
            </span>
            <a href={`mailto:${customer.email}`} className="text-ink-700 hover:text-brand-600 transition-colors truncate">
              {customer.email}
            </a>
          </div>
        )}
        {customer.phone && (
          <div className="flex items-center gap-2.5">
            <span className="w-6 h-6 rounded-md bg-ink-100 text-ink-500 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0">
              <Phone size={12} />
            </span>
            <a href={`tel:${customer.phone}`} className="text-ink-700 hover:text-brand-600 transition-colors">
              {customer.phone}
            </a>
          </div>
        )}
        {addr && (
          <div className="flex items-start gap-2.5">
            <span className="w-6 h-6 rounded-md bg-ink-100 text-ink-500 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0 mt-0.5">
              <MapPin size={12} />
            </span>
            <span className="text-ink-600">{addr}</span>
          </div>
        )}
        {customer.notes && (
          <p className="text-ink-500 pt-2 whitespace-pre-wrap text-xs leading-relaxed border-t border-ink-100 mt-1">{customer.notes}</p>
        )}
      </div>
    </div>
  );
}

