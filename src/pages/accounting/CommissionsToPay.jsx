import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet, Calendar, Shield, ChevronRight, Download,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import StatCard from '../../components/StatCard.jsx';
import { formatDateTime, formatMoney } from '../../lib/format.js';
import { computeTotals, lineForTotals } from '../../lib/pricing.js';
import {
  cycleEnding, isoDate, parseISODate, formatCycle, clampPct,
} from '../../lib/commissionCycle.js';
import { downloadCsv } from '../../lib/csv.js';

/**
 * Read-only commissions report for Contabilidad. Mirrors the math of
 * admin/Commissions exactly — same cycle picker, same per-user
 * breakdown — but framed as "comisiones por pagar" rather than as an
 * internal HR review.
 *
 * Extra over the admin page: a CSV export sized for Odoo. Each row is
 * one contributing quote (no aggregation by employee — downstream Odoo
 * does that) with the cycle window stamped on every row so the
 * importer can re-attribute later.
 */
export default function CommissionsToPay() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';

  const [mode, setMode] = useState('current'); // 'current' | 'previous' | 'custom'
  const today = useMemo(() => new Date(), []);
  const cycles = useMemo(() => {
    const curr = cycleEnding(today, 0);
    const prev = cycleEnding(today, -1);
    return { curr, prev };
  }, [today]);
  const [customStart, setCustomStart] = useState(() => isoDate(cycles.curr.start));
  const [customEnd, setCustomEnd]     = useState(() => isoDate(cycles.curr.end));

  const cycle = useMemo(() => {
    if (mode === 'current') return cycles.curr;
    if (mode === 'previous') return cycles.prev;
    const start = parseISODate(customStart);
    const end   = parseISODate(customEnd, /* endOfDay */ true);
    return { start, end };
  }, [mode, cycles, customStart, customEnd]);

  const profilesQ  = useLiveQueryStatus(() => db.profiles.toArray(), [], []);
  const quotesQ    = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const linesQ     = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);
  const customersQ = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );

  const profiles  = profilesQ.data;
  const quotes    = quotesQ.data;
  const lines     = linesQ.data;
  const customers = customersQ.data;
  const loaded = profilesQ.loaded && quotesQ.loaded && linesQ.loaded && customersQ.loaded;

  const derived = useMemo(() => {
    const profilesById = new Map();
    for (const p of profiles) profilesById.set(p.id, p);
    const customersById = new Map();
    for (const c of customers) customersById.set(c.id, c);

    const linesByQuote = new Map();
    for (const ln of lines) {
      if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
      linesByQuote.get(ln.quoteId).push(ln);
    }
    function totalsFor(q) {
      const rows = (linesByQuote.get(q.id) || [])
        .filter((l) => l.kind !== 'section')
        .map(lineForTotals);
      const t = computeTotals(rows, q);
      return { base: t.taxableBase, grandTotal: t.grandTotal };
    }

    const inWindow = quotes.filter((q) =>
      q.depositReceivedAt &&
      q.depositReceivedAt >= cycle.start &&
      q.depositReceivedAt <= cycle.end &&
      q.createdByUserId
    );

    const byUser = new Map();
    let cycleBase = 0;
    let cycleCommission = 0;
    for (const q of inWindow) {
      const user = profilesById.get(q.createdByUserId);
      if (!user) continue;
      const { base, grandTotal } = totalsFor(q);
      const pct = clampPct(user.commissionPct);
      const commission = base * (pct / 100);
      cycleBase += base;
      cycleCommission += commission;
      if (!byUser.has(user.id)) {
        byUser.set(user.id, {
          user,
          pct,
          quotes: [],
          base: 0,
          commission: 0,
        });
      }
      const entry = byUser.get(user.id);
      entry.quotes.push({
        quote: q,
        customer: q.customerId ? customersById.get(q.customerId) : null,
        base,
        grandTotal,
        commission,
      });
      entry.base += base;
      entry.commission += commission;
    }

    const rows = [...byUser.values()]
      .filter((r) => r.commission > 0 || r.base > 0)
      .sort((a, b) => b.commission - a.commission);

    return {
      rows,
      cycleBase,
      cycleCommission,
      depositedCount: inWindow.length,
      activeEmployees: rows.length,
    };
  }, [profiles, quotes, lines, customers, cycle]);

  function exportCsv() {
    const header = [
      'cycle_start',
      'cycle_end',
      'employee_name',
      'employee_email',
      'quote_number',
      'customer',
      'deposit_date',
      'base_imponible_usd',
      'grand_total_usd',
      'commission_pct',
      'commission_amount_usd',
    ];
    const rows = [header];
    const cycleStartIso = isoDate(cycle.start);
    const cycleEndIso   = isoDate(cycle.end);
    for (const r of derived.rows) {
      for (const e of r.quotes) {
        const customerLabel = e.customer
          ? (e.customer.company || e.customer.name || '')
          : '';
        rows.push([
          cycleStartIso,
          cycleEndIso,
          r.user.name || '',
          r.user.email || '',
          e.quote.number != null ? String(e.quote.number) : '',
          customerLabel,
          e.quote.depositReceivedAt ? isoDate(e.quote.depositReceivedAt) : '',
          // Money columns: plain numbers, two decimals, no thousands
          // separators — Excel/Odoo parse these as numerics.
          e.base.toFixed(2),
          e.grandTotal.toFixed(2),
          r.pct,
          e.commission.toFixed(2),
        ]);
      }
    }
    downloadCsv(`comisiones-${cycleStartIso}-a-${cycleEndIso}.csv`, rows);
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Comisiones por pagar" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página."
        />
      </>
    );
  }

  const exportDisabled = !loaded || derived.rows.length === 0;

  return (
    <>
      <PageHeader
        title="Comisiones por pagar"
        subtitle={`Ciclo ${formatCycle(cycle)} — para tu equipo de contabilidad`}
        actions={
          <button
            type="button"
            onClick={exportCsv}
            disabled={exportDisabled}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            title={exportDisabled ? 'Sin comisiones para exportar en este ciclo' : 'Descargar CSV para Odoo'}
          >
            <Download size={14} /> Exportar CSV
          </button>
        }
      />

      {/* Cycle picker */}
      <div className="card card-pad mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <CyclePill
            label="Ciclo actual"
            sub={formatCycle(cycles.curr)}
            active={mode === 'current'}
            onClick={() => setMode('current')}
          />
          <CyclePill
            label="Ciclo anterior"
            sub={formatCycle(cycles.prev)}
            active={mode === 'previous'}
            onClick={() => setMode('previous')}
          />
          <CyclePill
            label="Personalizado"
            sub={mode === 'custom' ? formatCycle({ start: parseISODate(customStart), end: parseISODate(customEnd, true) }) : 'Rango manual'}
            active={mode === 'custom'}
            onClick={() => setMode('custom')}
          />
        </div>
        {mode === 'custom' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-ink-100">
            <div>
              <div className="label">Desde</div>
              <input
                type="date"
                className="input"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </div>
            <div>
              <div className="label">Hasta</div>
              <input
                type="date"
                className="input"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <StatCard
          tone="emerald"
          icon={Wallet}
          label="Comisiones por pagar"
          value={loaded ? formatMoney(derived.cycleCommission, 'USD', { USD: 1 }) : '—'}
          hint={loaded ? `Sobre ${formatMoney(derived.cycleBase, 'USD', { USD: 1 })} en base imponible (sin ITBIS)` : 'Cargando…'}
        />
        <StatCard
          tone="brand"
          icon={Wallet}
          label="Ventas depositadas"
          value={loaded ? String(derived.depositedCount) : '—'}
          hint={loaded
            ? (derived.depositedCount === 1
                ? 'cotización con depósito en el periodo'
                : 'cotizaciones con depósito en el periodo')
            : 'Cargando…'}
        />
        <StatCard
          tone="ink"
          icon={Wallet}
          label="Empleados con comisión"
          value={loaded ? String(derived.activeEmployees) : '—'}
          hint={loaded
            ? (derived.activeEmployees === 0
                ? 'sin comisiones acreditadas'
                : (derived.activeEmployees === 1 ? 'empleado con comisión' : 'empleados con comisión'))
            : 'Cargando…'}
        />
      </div>

      <section className="card overflow-hidden">
        <header className="card-header">
          <h2>Detalle por empleado</h2>
        </header>
        {!loaded ? (
          <ListLoading rows={5} />
        ) : derived.rows.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="Sin comisiones en este ciclo"
            description="Cambia el ciclo o espera a que se depositen las cotizaciones del periodo."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {derived.rows.map((row) => (
              <UserRow key={row.user.id} row={row} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-user row — collapsed by default; clicking expands to the list of
// contributing quotes. Mirrors admin/Commissions.UserRow visually but
// links open in the same surface — Contabilidad doesn't have access to
// /quotes/<id>, so the per-quote rows here are plain text (no link).
// ---------------------------------------------------------------------------
function UserRow({ row }) {
  const [open, setOpen] = useState(false);
  const { user, pct, base, commission, quotes } = row;
  const { currentProfile } = useApp();
  // Admins viewing this page (for debugging the integration) get the
  // quote drill-down link to /quotes/<id>; Contabilidad does not (the
  // route is sales-only — clicking it would route them through
  // /quotes which they shouldn't see).
  const canLinkToQuote = currentProfile?.role === 'admin';

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-ink-50 transition-colors"
      >
        <Avatar name={user.name || user.email} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{user.name || user.email || '—'}</div>
          <div className="text-[11px] text-ink-500 truncate">
            {quotes.length} {quotes.length === 1 ? 'cotización' : 'cotizaciones'} · {pct}% comisión
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium tabular-nums whitespace-nowrap">
            {formatMoney(commission, 'USD', { USD: 1 })}
          </div>
          <div className="text-[11px] text-ink-500 tabular-nums">
            base {formatMoney(base, 'USD', { USD: 1 })}
          </div>
        </div>
        <ChevronRight
          size={14}
          className={`text-ink-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {open && (
        <ul className="bg-ink-50/60 border-t border-ink-100 divide-y divide-ink-100">
          {quotes.map(({ quote, customer, base: b, grandTotal, commission: c }) => {
            const main = (
              <>
                <div className="text-sm font-medium truncate">
                  #{quote.number || '—'}
                  {customer && (
                    <span className="font-normal text-ink-500"> · {customer.company || customer.name}</span>
                  )}
                </div>
                <div className="text-[11px] text-ink-500">
                  Depósito · {formatDateTime(quote.depositReceivedAt)}
                </div>
              </>
            );
            return (
              <li key={quote.id} className="px-5 py-2.5 pl-14 flex items-center gap-3">
                {canLinkToQuote ? (
                  <Link
                    to={`/quotes/${quote.id}`}
                    className="flex-1 min-w-0 hover:text-brand-700 transition-colors"
                  >
                    {main}
                  </Link>
                ) : (
                  <div className="flex-1 min-w-0">{main}</div>
                )}
                <div className="text-right">
                  <div className="text-sm tabular-nums whitespace-nowrap">
                    {formatMoney(b, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}
                  </div>
                  <div className="text-[10px] text-ink-400 tabular-nums whitespace-nowrap">
                    Total c/ ITBIS {formatMoney(grandTotal, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}
                  </div>
                  <div className="text-[11px] text-emerald-700 tabular-nums whitespace-nowrap">
                    +{formatMoney(c, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function CyclePill({ label, sub, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-md border px-3 py-2 transition ${
        active
          ? 'border-ink-700 bg-ink-700 text-white'
          : 'border-ink-200 hover:border-ink-400 bg-white'
      }`}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Calendar size={12} className={active ? 'text-ink-300' : 'text-ink-500'} />
        {label}
      </div>
      <div className={`text-[10px] mt-0.5 ${active ? 'text-ink-300' : 'text-ink-500'}`}>{sub}</div>
    </button>
  );
}

function Avatar({ name }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n.charAt(0).toUpperCase())
    .join('');
  return (
    <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-ink-100 text-ink-700 text-xs font-semibold flex-shrink-0">
      {initials || '?'}
    </span>
  );
}
