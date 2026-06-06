import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, ArrowRight, Send, CheckCircle2, FileEdit, Clock,
} from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import ListLoading from '../components/ListLoading.jsx';
import ScopeToggle, { SCOPE_MINE, SCOPE_TEAM } from '../components/ScopeToggle.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db } from '../db/database.js';
import { formatMoney } from '../lib/format.js';
import { displayRatesFor } from '../lib/exchangeRate.js';
import { resolveDashboard } from '../core/quote/views/dashboard.js';

/**
 * Seller home — a quoting-activity workspace, not an admin report. Built
 * around what a salesperson does next, scoped to their own quotes by
 * default (the team toggle widens it). Deliberately omits revenue roll-ups
 * and order/container logistics — those belong on an admin/accounting view.
 *
 * Three productivity sections, top → bottom:
 *   1. Enviadas · esperando respuesta — the follow-up list. Sent quotes,
 *      OLDEST first, each showing how long it's been waiting so the dealer
 *      chases the stalest deals first; 7+ days flags for follow-up.
 *   2. Aceptadas · en proceso — won quotes, each tagged with its real next
 *      milestone (Anticipo / Balance / Entrega pendiente, per
 *      lib/quoteMilestones), most-pending first.
 *   3. Borradores · continuar — unfinished quotes to resume and send.
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

const STALE_DAYS = 7; // a sent quote older than this nudges a follow-up.

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
  const allLinesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);

  const allQuotes = allQuotesQ.data;
  const loaded = allQuotesQ.loaded && allCustomersQ.loaded && allLinesQ.loaded;

  // Derivation lives in the Model (core/quote/views/dashboard); the page passes
  // the data + the resolved scope flag and renders the result.
  const derived = useMemo(
    () => resolveDashboard({
      quotes: allQuotes,
      customers: allCustomersQ.data,
      lines: allLinesQ.data,
      scopeIsTeam: effectiveScope === SCOPE_TEAM,
      meId,
    }),
    [allQuotes, allCustomersQ.data, allLinesQ.data, effectiveScope, meId],
  );

  const firstName = (currentProfile?.name || '').trim().split(/\s+/)[0];
  const money = (q) => formatMoney(derived.totalByQuote.get(q.id) || 0, q.currencyCode || 'USD', displayRatesFor(q, settings));
  const customerName = (q) => {
    const c = derived.customersById.get(q.customerId);
    return c?.company || c?.name || 'Sin cliente';
  };

  return (
    <>
      <PageHeader
        title={firstName ? `Hola, ${firstName}` : 'Inicio'}
        subtitle={settings?.companyName || 'Tu empresa'}
        actions={
          <div className="flex items-center gap-2">
            {meId && <ScopeToggle scope={scope} onChange={setScope} />}
            <Link to="/quotes/new" className="btn-brand">
              <Plus size={14} /> Nueva cotización
            </Link>
          </div>
        }
      />

      {/* The two active funnels a seller lives in. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Enviadas — the follow-up list, oldest first. */}
        <section className="card overflow-hidden">
          <header className="card-header">
            <h2 className="flex items-center gap-2">
              <Send size={14} className="text-ink-500" />
              Esperando respuesta
              {loaded && derived.sent.length > 0 && (
                <span className="badge">{derived.sent.length}</span>
              )}
            </h2>
            <Link to={`/quotes?status=sent&scope=${effectiveScope}`} className="card-header-action">
              Ver enviadas <ArrowRight size={12} />
            </Link>
          </header>
          {!loaded ? (
            <ListLoading rows={4} dense />
          ) : derived.sent.length === 0 ? (
            <EmptyRow text="No tienes cotizaciones esperando respuesta." />
          ) : (
            <ul className="divide-y divide-ink-100 max-h-[420px] overflow-y-auto">
              {derived.sent.map((q) => {
                const waited = relDays(q.sentAt || q.updatedAt);
                const stale = q.sentAt && (Date.now() - q.sentAt) / 86400000 >= STALE_DAYS;
                return (
                  <li key={q.id}>
                    <Link to={`/quotes/${q.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors">
                      <div className="text-sm font-medium tabular-nums w-14 flex-shrink-0">#{q.number || '—'}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">{customerName(q)}</div>
                        <div className={`text-[11px] truncate flex items-center gap-1 ${stale ? 'text-amber-700 font-medium' : 'text-ink-500'}`}>
                          {stale && <Clock size={11} className="flex-shrink-0" />}
                          Enviada {waited}{stale ? ' · da seguimiento' : ''}
                        </div>
                      </div>
                      <div className="text-sm font-medium tabular-nums whitespace-nowrap text-right flex-shrink-0">{money(q)}</div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Aceptadas — won deals, tagged with their next milestone. */}
        <section className="card overflow-hidden">
          <header className="card-header">
            <h2 className="flex items-center gap-2">
              <CheckCircle2 size={14} className="text-emerald-600" />
              Aceptadas · en proceso
              {loaded && derived.accepted.length > 0 && (
                <span className="badge">{derived.accepted.length}</span>
              )}
            </h2>
            <Link to={`/quotes?status=accepted&scope=${effectiveScope}`} className="card-header-action">
              Ver aceptadas <ArrowRight size={12} />
            </Link>
          </header>
          {!loaded ? (
            <ListLoading rows={4} dense />
          ) : derived.accepted.length === 0 ? (
            <EmptyRow text="Aún no tienes cotizaciones aceptadas." />
          ) : (
            <ul className="divide-y divide-ink-100 max-h-[420px] overflow-y-auto">
              {derived.accepted.map(({ q, step }) => (
                <li key={q.id}>
                  <Link to={`/quotes/${q.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors">
                    <div className="text-sm font-medium tabular-nums w-14 flex-shrink-0">#{q.number || '—'}</div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{customerName(q)}</div>
                      <div className="text-[11px] text-ink-500 truncate">{money(q)}</div>
                    </div>
                    <span className={`status-pill ${step.cls} flex-shrink-0`}>{step.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Borradores — resume unfinished quotes. */}
      <section className="card overflow-hidden mt-4">
        <header className="card-header">
          <h2 className="flex items-center gap-2">
            <FileEdit size={14} className="text-ink-500" />
            Borradores · continuar
            {loaded && derived.drafts.length > 0 && (
              <span className="badge">{derived.drafts.length}</span>
            )}
          </h2>
          <Link to={`/quotes?status=draft&scope=${effectiveScope}`} className="card-header-action">
            Ver borradores <ArrowRight size={12} />
          </Link>
        </header>
        {!loaded ? (
          <ListLoading rows={3} dense />
        ) : derived.drafts.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            No tienes borradores.{' '}
            <Link to="/quotes/new" className="text-ink-900 underline">Empieza una cotización</Link>.
          </div>
        ) : (
          <ul className="divide-y divide-ink-100 max-h-[320px] overflow-y-auto">
            {derived.drafts.slice(0, 8).map((q) => (
              <li key={q.id}>
                <Link to={`/quotes/${q.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-ink-50 transition-colors">
                  <div className="text-sm font-medium tabular-nums w-14 flex-shrink-0">#{q.number || '—'}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{customerName(q)}</div>
                    <div className="text-[11px] text-ink-500 truncate">Editada {relDays(q.updatedAt)}</div>
                  </div>
                  <div className="text-sm font-medium tabular-nums whitespace-nowrap text-right flex-shrink-0">{money(q)}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function EmptyRow({ text }) {
  return <div className="px-5 py-10 text-center text-sm text-ink-500">{text}</div>;
}
