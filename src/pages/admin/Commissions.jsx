import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, ArrowRight, Calendar, Shield, ChevronRight } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import StatCard from '../../components/StatCard.jsx';
import { formatDateTime, formatMoney } from '../../lib/format.js';
import { computeTotals } from '../../lib/pricing.js';

/**
 * Admin-only monthly commissions report. The dealer pays out on the
 * 15th of each month, covering a cycle that runs from the 16th of the
 * previous month through the 15th of the current month. This page is
 * the payout review.
 *
 * Inputs:
 *   • profiles    — id → name, commission_pct
 *   • quotes      — only those with depositReceivedAt in the window
 *                   AND a created_by_user_id we can attribute to
 *   • quoteLines  — drive each quote's taxableBase via computeTotals.
 *                   Per the dealer's rule, commissions are paid on
 *                   the base imponible (pre-ITBIS, pre-shipping) —
 *                   never on the grand total. We surface the grand
 *                   total in the per-quote drill-down for context.
 *   • customers   — for per-quote drill-down rows
 *
 * Output:
 *   • Cycle picker (this cycle / last cycle / custom)
 *   • Summary card (totals + counts)
 *   • Per-user table sorted by commission earned descending. Each row
 *     expands into the contributing quotes (number, customer, deposit
 *     date, base imponible, grand total c/ ITBIS, commission slice).
 *
 * Quotes without an attributable creator are silently skipped — the
 * monthly payout would be wrong to credit them to a random dealer, so
 * we under-report instead. Those quotes are visible in the rest of
 * the app; they just don't earn commission for anyone.
 */
export default function AdminCommissions() {
  const { profileId, currentProfile } = useApp();
  const isAdmin = currentProfile?.role === 'admin';

  // Cycle state lives here as a small state machine. `mode` controls
  // which preset is active; `customStart` / `customEnd` only matter
  // when mode === 'custom'.
  const [mode, setMode] = useState('current'); // 'current' | 'previous' | 'custom'
  const today = useMemo(() => new Date(), []);
  const cycles = useMemo(() => {
    const curr = cycleEnding(today, 0);
    const prev = cycleEnding(today, -1);
    return { curr, prev };
  }, [today]);
  const [customStart, setCustomStart] = useState(() => isoDate(cycles.curr.start));
  const [customEnd, setCustomEnd]     = useState(() => isoDate(cycles.curr.end));

  const window = useMemo(() => {
    if (mode === 'current') return cycles.curr;
    if (mode === 'previous') return cycles.prev;
    // custom — parse the date inputs as local-midnight, end-of-day for end.
    const start = parseISODate(customStart);
    const end   = parseISODate(customEnd, /* endOfDay */ true);
    return { start, end };
  }, [mode, cycles, customStart, customEnd]);

  // Always run the queries — the access-gate early-return below would
  // change the hook count between renders if we placed it earlier.
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

  // Derive everything from the raw rows in one pass — same shape as
  // Dashboard.jsx, so we don't re-render six times as queries resolve.
  const derived = useMemo(() => {
    const profilesById = new Map();
    for (const p of profiles) profilesById.set(p.id, p);
    const customersById = new Map();
    for (const c of customers) customersById.set(c.id, c);

    // Per-quote totals, mapping unitPrice → basePrice and stripping
    // section rows (same dance pricing.computeTotals expects). We
    // return BOTH the base imponible (commissionable) and the grand
    // total (informational — useful when the admin wants to see the
    // invoice headline). Commissions are paid on `base` per the
    // dealer's rule; grand total never enters the math.
    const linesByQuote = new Map();
    for (const ln of lines) {
      if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
      linesByQuote.get(ln.quoteId).push(ln);
    }
    function totalsFor(q) {
      const rows = (linesByQuote.get(q.id) || [])
        .filter((l) => l.kind !== 'section')
        .map((l) => ({
          qty: l.qty,
          basePrice: l.unitPrice,
          lineMarginPct: l.lineMarginPct,
          lineDiscountPct: l.lineDiscountPct,
        }));
      const t = computeTotals(rows, q);
      return { base: t.taxableBase, grandTotal: t.grandTotal };
    }

    // Quotes in the window: deposited within window AND attributable
    // to a user.
    const inWindow = quotes.filter((q) =>
      q.depositReceivedAt &&
      q.depositReceivedAt >= window.start &&
      q.depositReceivedAt <= window.end &&
      q.createdByUserId
    );

    // Group by creator.
    const byUser = new Map();
    let cycleBase = 0;
    let cycleCommission = 0;
    for (const q of inWindow) {
      const user = profilesById.get(q.createdByUserId);
      if (!user) continue;          // attributed to a deleted profile
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
      // Don't show 0-commission rows — better to omit than render a
      // zero that looks like a bug.
      .filter((r) => r.commission > 0 || r.base > 0)
      .sort((a, b) => b.commission - a.commission);

    return {
      rows,
      cycleBase,
      cycleCommission,
      depositedCount: inWindow.length,
      activeEmployees: rows.length,
    };
  }, [profiles, quotes, lines, customers, window]);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Comisiones" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Solo administradores pueden ver el reporte de comisiones."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Comisiones"
        subtitle={`Ciclo ${formatCycle(window)}`}
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

      {/* Summary card */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <StatCard
          tone="emerald"
          icon={Wallet}
          label="Comisiones del ciclo"
          value={loaded ? formatMoney(derived.cycleCommission, 'USD', { USD: 1 }) : '—'}
          hint={loaded ? `Sobre ${formatMoney(derived.cycleBase, 'USD', { USD: 1 })} en base imponible (sin ITBIS)` : 'Cargando…'}
        />
        <StatCard
          tone="brand"
          icon={Wallet}
          label="Ventas depositadas"
          value={loaded ? String(derived.depositedCount) : '—'}
          hint={loaded ? (derived.depositedCount === 1 ? 'cotización con depósito en el periodo' : 'cotizaciones con depósito en el periodo') : 'Cargando…'}
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

      {/* Per-user breakdown */}
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
// Per-user row — collapsed by default. Clicking expands to the list of
// contributing quotes (deposit date, total, commission slice). React
// state instead of <details>/<summary> so the chevron icon can rotate
// in sync with the open state.
// ---------------------------------------------------------------------------
function UserRow({ row }) {
  const [open, setOpen] = useState(false);
  const { user, pct, base, commission, quotes } = row;

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
          {quotes.map(({ quote, customer, base: b, grandTotal, commission: c }) => (
            <li key={quote.id} className="px-5 py-2.5 pl-14 flex items-center gap-3">
              <Link
                to={`/quotes/${quote.id}`}
                className="flex-1 min-w-0 hover:text-brand-700 transition-colors"
              >
                <div className="text-sm font-medium truncate">
                  #{quote.number || '—'}
                  {customer && (
                    <span className="font-normal text-ink-500"> · {customer.company || customer.name}</span>
                  )}
                </div>
                <div className="text-[11px] text-ink-500">
                  Depósito · {formatDateTime(quote.depositReceivedAt)}
                </div>
              </Link>
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
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Cycle pill — three of these render in a row at the top of the page.
// Active state inverts to ink-900 to match the rest of the app's button
// chrome; sub-label is the date range for context.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Cycle math
// ---------------------------------------------------------------------------

/**
 * Returns the cycle that *ends* `offsetMonths` months from the current
 * 15th. offset=0 = "active cycle"; offset=-1 = "previous cycle".
 *
 * The active cycle runs from the 16th of the prior month through the
 * 15th of "this" month — where "this" month is the next 15th still
 * coming. Before the 15th, "this" is the current calendar month;
 * from the 16th onward, "this" rolls forward.
 */
function cycleEnding(now, offsetMonths) {
  const day = now.getDate();
  const baseEndMonth = day <= 15 ? now.getMonth() : now.getMonth() + 1;
  const endMonth = baseEndMonth + offsetMonths;
  const year = now.getFullYear();
  const end   = new Date(year, endMonth, 15, 23, 59, 59, 999);
  const start = new Date(year, endMonth - 1, 16, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function isoDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISODate(iso, endOfDay = false) {
  if (!iso) return Date.now();
  const [y, m, d] = iso.split('-').map(Number);
  const date = endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  return date.getTime();
}

function formatCycle({ start, end }) {
  const opts = { day: 'numeric', month: 'short' };
  const s = new Date(start).toLocaleDateString('es-DO', opts);
  const e = new Date(end).toLocaleDateString('es-DO', opts);
  const year = new Date(end).getFullYear();
  return `${s} — ${e}, ${year}`;
}

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}
