import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, ArrowRight, Send, CheckCircle2, FileEdit, Clock, Package, Trophy, UserPlus,
} from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import ListLoading from '../components/ListLoading.jsx';
import StatCard from '../components/StatCard.jsx';
import ScopeToggle, { SCOPE_MINE, SCOPE_TEAM } from '../components/ScopeToggle.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db } from '../db/database.js';
import { formatMoney } from '../lib/format.js';
import { displayRatesFor } from '../lib/exchangeRate.js';
import { orderStatusPill } from '../lib/statusPill.js';
import { resolveDashboard } from '../core/quote/views/dashboard.js';

/**
 * Seller home — a quoting-activity workspace, not an admin report. Built
 * around what a salesperson does next, scoped to their own quotes by
 * default (the team toggle widens it). Deliberately omits revenue roll-ups
 * — those belong on an admin/accounting view.
 *
 * Layout, top → bottom (everything derived in core/quote/views/dashboard):
 *   1. KPI strip — four small tiles (Borradores / Enviadas with a stale
 *      accent / En proceso / Ganadas este mes), each deep-linking into the
 *      pre-filtered Quotes list.
 *   2. Enviadas · esperando respuesta — THE follow-up list, OLDEST first,
 *      each showing how long it's been waiting so the dealer chases the
 *      stalest deals first; 7+ days flags for follow-up. Gets the wide
 *      column — it's the seller's priority queue.
 *   3. Aceptadas · en proceso — won quotes, each tagged with its real next
 *      milestone (Anticipo / Balance / Entrega pendiente), most-pending
 *      first — and Borradores · continuar, stacked in the narrow column.
 *   4. Pedidos en curso — the team's active LR orders with their logistics
 *      stage, so the seller sees where the goods are without leaving home.
 *
 * Per-quote deal value is shown (it helps prioritise), but no aggregate
 * "sales number" — that's an admin concern, not a seller's daily driver.
 */

// "hoy" / "ayer" / "hace N días" from a timestamp.
function relDays(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  return `hace ${d} días`;
}

const LIST_CAP = 6;   // rows per work queue before "Ver todas →"
const ORDERS_CAP = 5; // rows in the Pedidos en curso strip

export default function Dashboard() {
  const { profileId, currentProfile, settings } = useApp();
  const meId = currentProfile?.id || null;
  const [scope, setScope] = useState(SCOPE_MINE);
  // Can't scope to "mine" without knowing who I am — fall back to team.
  const effectiveScope = meId ? scope : SCOPE_TEAM;

  const allQuotesQ = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const allCustomersQ = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const allOrdersQ = useLiveQueryStatus(
    () => db.orders.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const allContainersQ = useLiveQueryStatus(
    () => db.containers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const allLinesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);

  const allQuotes = allQuotesQ.data;
  const loaded = allQuotesQ.loaded && allCustomersQ.loaded && allLinesQ.loaded
    && allOrdersQ.loaded && allContainersQ.loaded;

  // Derivation lives in the Model (core/quote/views/dashboard); the page passes
  // the data + the resolved scope flag and renders the result.
  const derived = useMemo(
    () => resolveDashboard({
      quotes: allQuotes,
      customers: allCustomersQ.data,
      lines: allLinesQ.data,
      orders: allOrdersQ.data,
      containers: allContainersQ.data,
      scopeIsTeam: effectiveScope === SCOPE_TEAM,
      meId,
    }),
    [allQuotes, allCustomersQ.data, allLinesQ.data, allOrdersQ.data, allContainersQ.data, effectiveScope, meId],
  );

  const firstName = (currentProfile?.name || '').trim().split(/\s+/)[0];
  const money = (q) => formatMoney(derived.totalByQuote.get(q.id) || 0, q.currencyCode || 'USD', displayRatesFor(q, settings));
  const customerName = (q) => {
    const c = derived.customersById.get(q.customerId);
    return c?.company || c?.name || 'Sin cliente';
  };

  const { kpis } = derived;
  const quotesLink = (status) => `/quotes?status=${status}&scope=${effectiveScope}`;
  const isEmpty = loaded && derived.scopedCount === 0 && derived.activeOrders.length === 0;
  const showAccepted = !loaded || derived.accepted.length > 0;
  const showDrafts = !loaded || derived.drafts.length > 0;
  const hasSideColumn = showAccepted || showDrafts;

  return (
    <>
      <PageHeader
        title={firstName ? `Hola, ${firstName}` : 'Inicio'}
        subtitle={settings?.companyName || 'Tu empresa'}
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {meId && <ScopeToggle scope={scope} onChange={setScope} />}
            <Link to="/customers" className="btn-secondary">
              <UserPlus size={14} /> Cliente
            </Link>
            <Link to="/quotes/new" className="btn-brand">
              <Plus size={14} /> Nueva cotización
            </Link>
          </div>
        }
      />

      {isEmpty ? (
        /* Friendly zero-state — nothing in scope yet, lead with the actions. */
        <div className="card card-pad text-center py-12">
          <div className="text-sm font-medium text-ink-900">Todo listo para empezar</div>
          <p className="text-sm text-ink-500 mt-1">
            Aún no tienes cotizaciones{effectiveScope === SCOPE_MINE ? ' tuyas' : ''}. Crea la primera o registra un cliente.
          </p>
          <div className="flex items-center justify-center gap-2 mt-4">
            <Link to="/customers" className="btn-secondary"><UserPlus size={14} /> Cliente</Link>
            <Link to="/quotes/new" className="btn-brand"><Plus size={14} /> Nueva cotización</Link>
          </div>
        </div>
      ) : (
        <>
          {/* KPI strip — every number comes from the VM; each tile deep-links
              into the pre-filtered Quotes list. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <StatCard
              label="Borradores"
              value={loaded ? kpis.draftCount : '—'}
              icon={FileEdit}
              to={quotesLink('draft')}
            />
            <StatCard
              label="Enviadas"
              value={loaded ? kpis.sentCount : '—'}
              icon={Send}
              hint={loaded && kpis.staleCount > 0
                ? <span className="text-amber-700 font-medium">{kpis.staleCount} sin respuesta +7 días</span>
                : 'esperando respuesta'}
              to={quotesLink('sent')}
            />
            <StatCard
              label="En proceso"
              value={loaded ? kpis.inProcessCount : '—'}
              icon={CheckCircle2}
              tone="emerald"
              hint="aceptadas sin entregar"
              to={quotesLink('accepted')}
            />
            <StatCard
              label="Ganadas este mes"
              value={loaded ? kpis.wonThisMonth : '—'}
              icon={Trophy}
              tone="brand"
              hint="cotizaciones aceptadas"
              to={quotesLink('accepted')}
            />
          </div>

          {/* Work queues. The follow-up list is the seller's priority — it
              gets the wide column; aceptadas + borradores stack beside it. */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
            <section className={`card overflow-hidden ${hasSideColumn ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
              <header className="card-header">
                <h2 className="flex items-center gap-2">
                  <Send size={14} className="text-ink-500" />
                  Esperando respuesta
                  {loaded && derived.sent.length > 0 && (
                    <span className="badge">{derived.sent.length}</span>
                  )}
                </h2>
                <Link to={quotesLink('sent')} className="card-header-action">
                  Ver todas <ArrowRight size={12} />
                </Link>
              </header>
              {!loaded ? (
                <ListLoading rows={4} dense />
              ) : derived.sent.length === 0 ? (
                <EmptyRow text="No tienes cotizaciones esperando respuesta." />
              ) : (
                <ul className="divide-y divide-ink-100">
                  {derived.sent.slice(0, LIST_CAP).map(({ q, sinceTs, stale }) => (
                    <li key={q.id}>
                      <Link to={`/quotes/${q.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors">
                        <div className="text-sm font-medium tabular-nums w-14 flex-shrink-0">#{q.number || '—'}</div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate">{customerName(q)}</div>
                          <div className={`text-[11px] truncate flex items-center gap-1 ${stale ? 'text-amber-700 font-medium' : 'text-ink-500'}`}>
                            {stale && <Clock size={11} className="flex-shrink-0" />}
                            Enviada {relDays(sinceTs)}{stale ? ' · da seguimiento' : ''}
                          </div>
                        </div>
                        <div className="text-sm font-medium tabular-nums whitespace-nowrap text-right flex-shrink-0">{money(q)}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {hasSideColumn && (
              <div className="space-y-4">
                {/* Aceptadas — won deals, tagged with their next milestone. */}
                {showAccepted && (
                  <section className="card overflow-hidden">
                    <header className="card-header">
                      <h2 className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-emerald-600" />
                        Aceptadas · en proceso
                        {loaded && (
                          <span className="badge">{derived.accepted.length}</span>
                        )}
                      </h2>
                      <Link to={quotesLink('accepted')} className="card-header-action">
                        Ver todas <ArrowRight size={12} />
                      </Link>
                    </header>
                    {!loaded ? (
                      <ListLoading rows={3} dense />
                    ) : (
                      <ul className="divide-y divide-ink-100">
                        {derived.accepted.slice(0, LIST_CAP).map(({ q, step }) => (
                          <li key={q.id}>
                            <Link to={`/quotes/${q.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors">
                              <div className="min-w-0 flex-1">
                                <div className="text-sm truncate">{customerName(q)}</div>
                                <div className="text-[11px] text-ink-500 truncate tabular-nums">#{q.number || '—'} · {money(q)}</div>
                              </div>
                              <span className={`status-pill ${step.cls} flex-shrink-0`}>{step.label}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

                {/* Borradores — resume unfinished quotes. */}
                {loaded && showDrafts && (
                  <section className="card overflow-hidden">
                    <header className="card-header">
                      <h2 className="flex items-center gap-2">
                        <FileEdit size={14} className="text-ink-500" />
                        Borradores · continuar
                        <span className="badge">{derived.drafts.length}</span>
                      </h2>
                      <Link to={quotesLink('draft')} className="card-header-action">
                        Ver todas <ArrowRight size={12} />
                      </Link>
                    </header>
                    <ul className="divide-y divide-ink-100">
                      {derived.drafts.slice(0, LIST_CAP).map((q) => (
                        <li key={q.id}>
                          <Link to={`/quotes/${q.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm truncate">{customerName(q)}</div>
                              <div className="text-[11px] text-ink-500 truncate tabular-nums">#{q.number || '—'} · editada {relDays(q.updatedAt)}</div>
                            </div>
                            <div className="text-sm font-medium tabular-nums whitespace-nowrap text-right flex-shrink-0">{money(q)}</div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </div>

          {/* Pedidos en curso — the team's active LR orders (shared logistics,
              so this strip ignores the Mías/Equipo scope). */}
          {loaded && derived.activeOrders.length > 0 && (
            <section className="card overflow-hidden mt-4">
              <header className="card-header">
                <h2 className="flex items-center gap-2">
                  <Package size={14} className="text-ink-500" />
                  Pedidos en curso
                  <span className="badge">{derived.activeOrders.length}</span>
                </h2>
                <Link to="/orders" className="card-header-action">
                  Ver pedidos <ArrowRight size={12} />
                </Link>
              </header>
              <ul className="divide-y divide-ink-100">
                {derived.activeOrders.slice(0, ORDERS_CAP).map(({ order: o, stage, customerLabel, quoteCount, containerCount, total }) => {
                  const pill = orderStatusPill(stage);
                  return (
                    <li key={o.id}>
                      <Link to={`/orders/${o.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors">
                        <div className="text-sm font-medium tabular-nums w-14 flex-shrink-0">#{o.number || '—'}</div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate">
                            {o.name || customerLabel || 'Pedido'}
                            {o.name && customerLabel ? <span className="text-ink-500"> · {customerLabel}</span> : ''}
                          </div>
                          <div className="text-[11px] text-ink-500 truncate tabular-nums">
                            {quoteCount} cot. · {containerCount} cont.{total > 0 ? ` · ${formatMoney(total, 'USD', { USD: 1 })}` : ''}
                          </div>
                        </div>
                        <span className={`status-pill ${pill.cls} flex-shrink-0`}>{pill.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}

function EmptyRow({ text }) {
  return <div className="px-5 py-8 text-center text-sm text-ink-500">{text}</div>;
}
