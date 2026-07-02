import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { UserSquare2, ExternalLink, Mail, Phone, Building2, Pencil, FileText, Hash } from 'lucide-react';
import BackLink from '../components/BackLink.jsx';
import PageHeader from '../components/PageHeader.jsx';
import ProfessionalModal from '../components/ProfessionalModal.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { displayRatesFor } from '../lib/exchangeRate.js';
import { resolveProfessionalDetail } from '../core/quote/views/detail.js';
import ContactChatCard from '../components/whatsapp/ContactChatCard.jsx';

/**
 * Detail view for one professional — the financial roll-up the
 * Customers page deliberately doesn't have. Shows their contact card on
 * top and underneath, every quote assigned to them grouped by status
 * (borrador / enviada / aceptada / archivada / etc.), with each
 * section's running totals and accrued commissions.
 *
 * Grouping by status was the user's pick over "all" or "only delivered"
 * — the dealer wants to see potential vs committed vs whatever-else at
 * a glance, not a single bottom number that conflates drafts with
 * actual revenue.
 */

const STATUS_ORDER = ['accepted', 'sent', 'draft', 'declined', 'archived'];
const STATUS_LABELS = {
  draft: 'Borradores',
  sent: 'Enviadas',
  accepted: 'Aceptadas',
  declined: 'Rechazadas',
  archived: 'Archivadas',
};
export default function ProfessionalDetail() {
  const { professionalId } = useParams();
  const { profileId, isAdmin } = useApp();
  const navigate = useNavigate();
  // Local state for the edit modal. The same ProfessionalModal
  // component the list page uses opens here too — passing
  // onAfterDelete navigates back to /professionals so the user
  // doesn't get stuck on a "Cargando profesional…" stub after
  // deleting the row they were just looking at.
  const [editing, setEditing] = useState(null);

  const { data: pro, loaded: proLoaded } = useLiveQueryStatus(
    () => db.professionals.get(professionalId),
    [professionalId],
    null,
  );

  // Pull every quote tagged with this professional. The where().equals()
  // chain is the cheap path (single indexed lookup) — far cheaper than
  // loading all quotes and filtering client-side.
  const quotes = useLiveQuery(
    () => db.quotes.where('professionalId').equals(professionalId).toArray(),
    [professionalId],
    [],
  );

  // Lines are needed to compute each quote's total. Filtering by quoteId
  // in a single .in() would be ideal, but the Dexie-shaped facade
  // doesn't expose that, so we fetch everything for the profile and
  // index client-side. The quote list per professional is small (tens,
  // not thousands), so this is fine.
  const allLines = useLiveQuery(
    () => db.quoteLines.toArray(),
    [],
    [],
  );

  // Customer names so each quote row reads as "Smith · $4,200" rather
  // than "#1001 · $4,200" with no human context.
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  // The ViewModel: every assigned quote grouped (and sorted) by status with
  // its base/total/commission split precomputed, plus the overall +
  // accepted-only summaries the headline cards show. The page renders
  // straight from this shape without re-doing the arithmetic on every paint.
  const { grouped, summary } = useMemo(
    () => resolveProfessionalDetail({
      pro,
      quotes,
      lines: allLines,
      customers,
    }),
    [pro, quotes, allLines, customers],
  );

  if (!pro) {
    // Distinguish first-fetch-in-flight from a genuinely missing record: a
    // deleted/bad id used to spin "Cargando profesional…" forever.
    if (!proLoaded) {
      return (
        <div className="card card-pad py-16 flex flex-col items-center gap-3 text-center">
          <span className="w-11 h-11 rounded-full bg-ink-50 flex items-center justify-center">
            <UserSquare2 size={20} className="text-ink-300" />
          </span>
          <p className="text-sm text-ink-500">Cargando profesional…</p>
        </div>
      );
    }
    return (
      <>
        <BackLink to="/professionals">Volver a profesionales</BackLink>
        <EmptyState
          icon={UserSquare2}
          title="Profesional no encontrado"
          description="Este profesional no existe o fue eliminado."
          action={<Link to="/professionals" className="btn-brand">Ver profesionales</Link>}
        />
      </>
    );
  }

  return (
    <>
      <BackLink to="/professionals">Volver a profesionales</BackLink>

      <PageHeader
        title={pro.name}
        subtitle={
          pro.company
            ? <><Building2 size={12} className="inline -mt-0.5 mr-1" />{pro.company}</>
            : (pro.email || null)
        }
        actions={
          <button
            type="button"
            onClick={() => setEditing(pro)}
            className="btn-secondary"
            title="Editar profesional"
          >
            <Pencil size={14} /> Editar
          </button>
        }
      />

      <ProfessionalModal
        professional={editing}
        onClose={() => setEditing(null)}
        onAfterDelete={() => navigate('/professionals')}
        profileId={profileId}
      />

      {/* Contact strip — small, dense, only shown if there's anything */}
      {(pro.email || pro.phone || pro.tradeNumber || pro.notes) && (
        <div className="card overflow-hidden mb-5">
          <div className="card-pad space-y-2.5 text-sm">
            {pro.tradeNumber && (
              <div className="flex items-center gap-2.5">
                <span className="w-6 h-6 rounded-md bg-amber-50 text-amber-700 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0">
                  <Hash size={12} />
                </span>
                <span className="text-ink-700">
                  Comercio Ligne Roset: <span className="font-medium">{pro.tradeNumber}</span>
                </span>
              </div>
            )}
            {pro.email && (
              <div className="flex items-center gap-2.5">
                <span className="w-6 h-6 rounded-md bg-brand-50 text-brand-600 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0">
                  <Mail size={12} />
                </span>
                <a href={`mailto:${pro.email}`} className="text-ink-700 hover:text-brand-600 transition-colors truncate">{pro.email}</a>
              </div>
            )}
            {pro.phone && (
              <div className="flex items-center gap-2.5">
                <span className="w-6 h-6 rounded-md bg-ink-100 text-ink-500 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0">
                  <Phone size={12} />
                </span>
                <a href={`tel:${pro.phone}`} className="text-ink-700 hover:text-brand-600 transition-colors">{pro.phone}</a>
              </div>
            )}
            {pro.notes && <p className="text-ink-500 pt-2 whitespace-pre-wrap text-xs leading-relaxed border-t border-ink-100 mt-1">{pro.notes}</p>}
          </div>
        </div>
      )}

      {/* The professional's WhatsApp conversation, right on their card —
          renders only with a phone + the Business API connected. Admin-only
          while the WhatsApp inbox is in testing. */}
      {isAdmin && (
        <div className="mb-5">
          <ContactChatCard contact={pro} contactKind="professional" />
        </div>
      )}

      {/* Roll-up cards: total pipeline + accepted (committed).
          Headline value is the base imponible — the amount commissions
          are calculated on — so the math reads cleanly. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard
          label="Base aceptada (sin ITBIS)"
          value={formatMoney(summary.acceptedBase, 'USD', { USD: 1 })}
          hint={
            <>
              Comisión: <span className="font-medium text-ink-900 tabular-nums">{formatMoney(summary.acceptedCommission, 'USD', { USD: 1 })}</span>
              {summary.acceptedTrade > 0 && (
                <> · Trade discount: <span className="font-medium text-amber-700 tabular-nums">{formatMoney(summary.acceptedTrade, 'USD', { USD: 1 })}</span></>
              )}
            </>
          }
          tone="emerald"
          accent
        />
        <StatCard
          label="Base total en pipeline"
          value={formatMoney(summary.totalBase, 'USD', { USD: 1 })}
          hint={
            <>
              Comisión: <span className="font-medium text-ink-900 tabular-nums">{formatMoney(summary.totalCommission, 'USD', { USD: 1 })}</span>
              {summary.totalTrade > 0 && (
                <> · Trade discount: <span className="font-medium text-amber-700 tabular-nums">{formatMoney(summary.totalTrade, 'USD', { USD: 1 })}</span></>
              )}
            </>
          }
          tone="ink"
          accent
        />
      </div>

      {/* Per-status sections. Empty groups are skipped — no need to
          render a "Rechazadas (0)" card cluttering the page. */}
      {quotes.length === 0 ? (
        <div className="card card-pad py-14 flex flex-col items-center gap-3 text-center">
          <span className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center">
            <UserSquare2 size={22} className="text-brand-400" />
          </span>
          <div>
            <p className="text-sm font-medium text-ink-700">Sin cotizaciones asignadas</p>
            <p className="text-xs text-ink-400 mt-0.5">Este profesional aún no tiene cotizaciones asignadas.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {STATUS_ORDER.map((status) => {
            const entries = grouped.get(status);
            if (!entries || entries.length === 0) return null;
            return (
              <StatusGroup
                key={status}
                status={status}
                entries={entries}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

// Chip tones per status so the card header feels intentional at a glance.
const STATUS_CHIP = {
  accepted: 'bg-emerald-50 text-emerald-700',
  sent: 'bg-blue-50 text-blue-700',
  draft: 'bg-ink-100 text-ink-600',
  declined: 'bg-rose-50 text-rose-600',
  archived: 'bg-ink-100 text-ink-400',
};

function StatusGroup({ status, entries }) {
  // Same rate source as the Quotes list (live until accepted, then locked).
  const { settings } = useApp();
  const totalBase = entries.reduce((s, e) => s + e.base, 0);
  const totalCommission = entries.reduce((s, e) => s + e.commission, 0);
  const totalTrade = entries.reduce((s, e) => s + e.tradeDiscount, 0);
  const chipClass = STATUS_CHIP[status] || 'bg-ink-100 text-ink-600';
  return (
    <section className="card overflow-hidden">
      <header className="card-header flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className={`w-7 h-7 rounded-lg ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0 ${chipClass}`}>
            <FileText size={13} />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className={`status-pill status-pill-${status}`}>
                {STATUS_LABELS[status] || status}
              </span>
              <span className="eyebrow-xs text-ink-400 tabular-nums">{entries.length} {entries.length === 1 ? 'cotización' : 'cotizaciones'}</span>
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold tabular-nums text-ink-900">{formatMoney(totalBase, 'USD', { USD: 1 })}</div>
          <div className="text-[11px] text-ink-500 tabular-nums">
            Comisión {formatMoney(totalCommission, 'USD', { USD: 1 })}
            {totalTrade > 0 && (
              <span className="text-amber-700"> · Trade {formatMoney(totalTrade, 'USD', { USD: 1 })}</span>
            )}
          </div>
        </div>
      </header>
      <ul className="divide-y divide-ink-100">
        {entries.map((e) => (
          <li key={e.quote.id} className="group px-5 py-3.5 flex items-center gap-3 flex-wrap hover:bg-brand-50/60 hover:shadow-xs active:scale-[0.99] transition-all duration-150">
            <Link
              to={`/quotes/${e.quote.id}`}
              className="flex-1 min-w-0 basis-36 group-hover:text-brand-700 transition-colors"
            >
              <div className="text-sm font-medium truncate text-ink-900 group-hover:text-brand-700 transition-colors">
                #{e.quote.number || '—'}
                {e.customer ? <span className="text-ink-500 font-normal group-hover:text-brand-500"> · {e.customer.company || e.customer.name}</span> : null}
              </div>
              <div className="text-[11px] text-ink-500 mt-0.5">
                Act. {formatDateTime(e.quote.updatedAt)}
              </div>
            </Link>
            {e.trade && (
              <span
                className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 whitespace-nowrap ring-1 ring-inset ring-amber-200/60"
                title="Trade discount: facturar al decorador (menos su %), sin comisión por pagar"
              >
                Trade · facturar al decorador
              </span>
            )}
            <div className="text-right shrink-0">
              <div className="text-sm font-semibold tabular-nums whitespace-nowrap text-ink-900">
                {formatMoney(e.base, e.quote.currencyCode || 'USD', displayRatesFor(e.quote, settings))}
              </div>
              <div className="text-[10px] text-ink-400 tabular-nums whitespace-nowrap">
                Total c/ ITBIS {formatMoney(e.grandTotal, e.quote.currencyCode || 'USD', displayRatesFor(e.quote, settings))}
              </div>
              <div className={`text-[11px] tabular-nums whitespace-nowrap ${e.trade ? 'text-amber-700' : 'text-ink-500'}`}>
                {e.pct}%{e.trade ? ' trade' : ''} → {formatMoney(e.amount, e.quote.currencyCode || 'USD', displayRatesFor(e.quote, settings))}
              </div>
            </div>
            <Link
              to={`/quotes/${e.quote.id}`}
              className="btn-ghost text-xs flex-shrink-0"
              title="Abrir cotización"
            >
              <ExternalLink size={13} aria-hidden /> Abrir
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
