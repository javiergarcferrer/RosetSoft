import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, UserSquare2, ExternalLink, Mail, Phone, Building2, Pencil } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import ProfessionalModal from '../components/ProfessionalModal.jsx';
import StatCard from '../components/StatCard.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { computeTotals, lineForTotals } from '../lib/pricing.js';
import { isPricedLine, QUOTE_STATUS_ACCEPTED } from '../lib/constants.js';
import { effectiveCommissionPct, commissionAmount, isTradeDiscount, reportedCommission } from '../lib/commissions.js';

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
  const { profileId } = useApp();
  const navigate = useNavigate();
  // Local state for the edit modal. The same ProfessionalModal
  // component the list page uses opens here too — passing
  // onAfterDelete navigates back to /professionals so the user
  // doesn't get stuck on a "Cargando profesional…" stub after
  // deleting the row they were just looking at.
  const [editing, setEditing] = useState(null);

  const pro = useLiveQuery(
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
  const customerById = useMemo(() => {
    const m = new Map();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  // Group by status; inside each group precompute total + commission so
  // the table renders straight from this shape without re-doing the
  // arithmetic on every paint.
  const grouped = useMemo(() => {
    if (!pro) return new Map();
    const linesByQuote = new Map();
    for (const ln of allLines) {
      if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
      linesByQuote.get(ln.quoteId).push(ln);
    }
    const byStatus = new Map();
    for (const q of quotes) {
      // Map `unitPrice` → `basePrice` for computeTotals — the pricing
      // module expects the post-catalog price under a different name
      // than what the DB stores. Compound lines collapse their
      // components into a single basePrice inside lineForTotals.
      // Sections are stripped: they have no qty/price, they're just
      // visual dividers in the quote.
      const lines = (linesByQuote.get(q.id) || [])
        .filter(isPricedLine)
        .map(lineForTotals);
      const totals = computeTotals(lines, q);
      const pct = effectiveCommissionPct(q);
      // Same rate, two AR directions. The $ amount is computed off the base
      // imponible (pre-ITBIS, pre-shipping) with any client discount drawn
      // out of it; whether it lands as a commission WE pay or a trade
      // discount WE bill the decorator is the per-quote modality. Trade
      // discount accrues no commission.
      // Once the commission is paid, freeze to the amount snapshotted at
      // payout so a later rate/order-type change can't restate this pro's
      // paid history; unpaid (and trade, which never pays a commission) stay
      // live. Trade discounts never set commissionPaidAt, so they pass through.
      const liveAmount = commissionAmount(totals, pct);
      const amount = reportedCommission(q.commissionPaidAt, q.commissionPaidAmount, liveAmount);
      const trade = isTradeDiscount(q);
      const entry = {
        quote: q,
        customer: q.customerId ? customerById.get(q.customerId) : null,
        base: totals.taxableBase,
        grandTotal: totals.grandTotal,
        pct,
        trade,
        amount,
        commission: trade ? 0 : amount,
        tradeDiscount: trade ? amount : 0,
      };
      const key = q.status || 'draft';
      if (!byStatus.has(key)) byStatus.set(key, []);
      byStatus.get(key).push(entry);
    }
    // Sort each group by most recent first — the dealer usually wants
    // to see the freshest deal at the top of each section.
    for (const arr of byStatus.values()) {
      arr.sort((a, b) => (b.quote.updatedAt || 0) - (a.quote.updatedAt || 0));
    }
    return byStatus;
  }, [pro, quotes, allLines, customerById]);

  // Overall roll-up across every status, plus accepted-only as the
  // "committed" figure the dealer cares about most for payouts.
  const summary = useMemo(() => {
    // "Sales" here is the taxable base (base imponible) — the same
    // amount commissions are calculated on, so the headline figures
    // and the commission column always line up arithmetically.
    let totalBase = 0;
    let totalCommission = 0;
    let totalTrade = 0;
    let acceptedBase = 0;
    let acceptedCommission = 0;
    let acceptedTrade = 0;
    for (const [status, entries] of grouped) {
      for (const e of entries) {
        totalBase += e.base;
        totalCommission += e.commission;
        totalTrade += e.tradeDiscount;
        if (status === QUOTE_STATUS_ACCEPTED) {
          acceptedBase += e.base;
          acceptedCommission += e.commission;
          acceptedTrade += e.tradeDiscount;
        }
      }
    }
    return {
      totalBase, totalCommission, totalTrade,
      acceptedBase, acceptedCommission, acceptedTrade,
    };
  }, [grouped]);

  if (!pro) {
    return (
      <div className="card card-pad text-center text-sm text-ink-500">
        Cargando profesional…
      </div>
    );
  }

  return (
    <>
      <Link to="/professionals" className="back-link">
        <ArrowLeft size={12} /> Volver a profesionales
      </Link>

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
      {(pro.email || pro.phone || pro.notes) && (
        <div className="card card-pad mb-5 text-sm space-y-1">
          {pro.email && (
            <div className="flex items-center gap-2">
              <Mail size={14} className="text-ink-400" />
              <a href={`mailto:${pro.email}`} className="text-ink-700 hover:text-brand-700">{pro.email}</a>
            </div>
          )}
          {pro.phone && (
            <div className="flex items-center gap-2">
              <Phone size={14} className="text-ink-400" />
              <a href={`tel:${pro.phone}`} className="text-ink-700 hover:text-brand-700">{pro.phone}</a>
            </div>
          )}
          {pro.notes && <p className="text-ink-500 pt-1 whitespace-pre-wrap">{pro.notes}</p>}
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
        <div className="card card-pad text-center text-sm text-ink-500">
          Este profesional aún no tiene cotizaciones asignadas.
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

function StatusGroup({ status, entries }) {
  const totalBase = entries.reduce((s, e) => s + e.base, 0);
  const totalCommission = entries.reduce((s, e) => s + e.commission, 0);
  const totalTrade = entries.reduce((s, e) => s + e.tradeDiscount, 0);
  return (
    <section className="card overflow-hidden">
      <header className="card-header flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`status-pill status-pill-${status}`}>
            {STATUS_LABELS[status] || status}
          </span>
          <span className="text-sm text-ink-700">{entries.length} {entries.length === 1 ? 'cotización' : 'cotizaciones'}</span>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">{formatMoney(totalBase, 'USD', { USD: 1 })}</div>
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
          <li key={e.quote.id} className="px-5 py-3 flex items-center gap-3 flex-wrap">
            <Link
              to={`/quotes/${e.quote.id}`}
              className="flex-1 min-w-[180px] hover:text-brand-700 transition-colors"
            >
              <div className="text-sm font-semibold truncate">
                #{e.quote.number || '—'}
                {e.customer ? <span className="text-ink-500 font-normal"> · {e.customer.company || e.customer.name}</span> : null}
              </div>
              <div className="text-[11px] text-ink-500">
                Act. {formatDateTime(e.quote.updatedAt)}
              </div>
            </Link>
            {e.trade && (
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 whitespace-nowrap"
                title="Trade discount: facturar al decorador (menos su %), sin comisión por pagar"
              >
                Trade · facturar al decorador
              </span>
            )}
            <div className="text-right">
              <div className="text-sm font-medium tabular-nums whitespace-nowrap">
                {formatMoney(e.base, e.quote.currencyCode || 'USD', e.quote.rates || { USD: 1 })}
              </div>
              <div className="text-[10px] text-ink-400 tabular-nums whitespace-nowrap">
                Total c/ ITBIS {formatMoney(e.grandTotal, e.quote.currencyCode || 'USD', e.quote.rates || { USD: 1 })}
              </div>
              <div className={`text-[11px] tabular-nums whitespace-nowrap ${e.trade ? 'text-amber-700' : 'text-ink-500'}`}>
                {e.pct}%{e.trade ? ' trade' : ''} → {formatMoney(e.amount, e.quote.currencyCode || 'USD', e.quote.rates || { USD: 1 })}
              </div>
            </div>
            <Link
              to={`/quotes/${e.quote.id}`}
              className="text-ink-400 hover:text-ink-900 p-1.5"
              title="Abrir cotización"
              aria-label="Abrir cotización"
            >
              <ExternalLink size={14} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
