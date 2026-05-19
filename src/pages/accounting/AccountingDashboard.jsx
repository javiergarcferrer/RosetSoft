import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet, FileCheck, Download, Shield, ArrowRight,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import StatCard from '../../components/StatCard.jsx';
import { formatMoney } from '../../lib/format.js';
import { computeTotals, lineForTotals } from '../../lib/pricing.js';
import { isPricedLine } from '../../lib/constants.js';
import { cycleEnding, formatCycle, clampPct } from '../../lib/commissionCycle.js';

/**
 * Read-only landing page for the Contabilidad surface. Three KPIs:
 *
 *   • Comisiones por pagar (ciclo actual)
 *   • Ventas depositadas (ciclo actual)
 *   • Cotizaciones aceptadas (mes en curso)
 *
 * Plus a row of shortcut cards to the three Contabilidad work pages.
 * Money figures are USD — Contabilidad pushes everything through Odoo
 * in dollars, so we don't show the dual-currency formatting that the
 * sales surfaces do.
 */
export default function AccountingDashboard() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';

  // Always run the queries — early-return below would change the hook
  // count between renders.
  const profilesQ  = useLiveQueryStatus(() => db.profiles.toArray(), [], []);
  const quotesQ    = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const linesQ     = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);

  const today = useMemo(() => new Date(), []);
  const cycle = useMemo(() => cycleEnding(today, 0), [today]);
  const monthStart = useMemo(() => {
    const d = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    return d.getTime();
  }, [today]);

  const derived = useMemo(() => {
    const profilesById = new Map();
    for (const p of profilesQ.data) profilesById.set(p.id, p);

    const linesByQuote = new Map();
    for (const ln of linesQ.data) {
      if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
      linesByQuote.get(ln.quoteId).push(ln);
    }
    function totalsFor(q) {
      const rows = (linesByQuote.get(q.id) || [])
        .filter(isPricedLine)
        .map(lineForTotals);
      return computeTotals(rows, q);
    }

    // Comisiones del ciclo — same rule as admin/Commissions: base
    // imponible × cada empleado's commission_pct, summed over every
    // quote with a deposit timestamp inside the cycle window.
    let cycleCommission = 0;
    let depositedCount = 0;
    for (const q of quotesQ.data) {
      if (!q.depositReceivedAt) continue;
      if (q.depositReceivedAt < cycle.start || q.depositReceivedAt > cycle.end) continue;
      if (!q.createdByUserId) continue;
      const user = profilesById.get(q.createdByUserId);
      if (!user) continue;
      const { taxableBase } = totalsFor(q);
      const pct = clampPct(user.commissionPct);
      cycleCommission += taxableBase * (pct / 100);
      depositedCount += 1;
    }

    // Mes en curso — accepted quotes whose acceptedAt falls in the
    // current calendar month. Grand-total sum.
    let monthAcceptedTotal = 0;
    let monthAcceptedCount = 0;
    const endOfDay = Date.now();
    for (const q of quotesQ.data) {
      if (q.status !== 'accepted') continue;
      if (!q.acceptedAt) continue;
      if (q.acceptedAt < monthStart || q.acceptedAt > endOfDay) continue;
      const { grandTotal } = totalsFor(q);
      monthAcceptedTotal += grandTotal;
      monthAcceptedCount += 1;
    }

    return { cycleCommission, depositedCount, monthAcceptedTotal, monthAcceptedCount };
  }, [profilesQ.data, quotesQ.data, linesQ.data, cycle, monthStart]);

  const loaded = profilesQ.loaded && quotesQ.loaded && linesQ.loaded;

  if (!allowed) {
    return (
      <>
        <PageHeader title="Contabilidad" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Contabilidad"
        subtitle={`Ciclo ${formatCycle(cycle)}`}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <StatCard
          tone="emerald"
          icon={Wallet}
          label="Comisiones por pagar"
          value={loaded ? formatMoney(derived.cycleCommission, 'USD', { USD: 1 }) : '—'}
          hint={loaded ? `Ciclo en curso · ${formatCycle(cycle)}` : 'Cargando…'}
        />
        <StatCard
          tone="brand"
          icon={Wallet}
          label="Ventas depositadas"
          value={loaded ? String(derived.depositedCount) : '—'}
          hint={loaded
            ? (derived.depositedCount === 1
                ? 'cotización con depósito en el ciclo'
                : 'cotizaciones con depósito en el ciclo')
            : 'Cargando…'}
        />
        <StatCard
          tone="ink"
          icon={FileCheck}
          label="Aceptadas (mes en curso)"
          value={loaded ? formatMoney(derived.monthAcceptedTotal, 'USD', { USD: 1 }) : '—'}
          hint={loaded
            ? `${derived.monthAcceptedCount} cotización${derived.monthAcceptedCount === 1 ? '' : 'es'} aceptada${derived.monthAcceptedCount === 1 ? '' : 's'}`
            : 'Cargando…'}
        />
      </div>

      <section className="card overflow-hidden">
        <header className="card-header">
          <h2>Atajos</h2>
        </header>
        <ul className="divide-y divide-ink-100">
          <ShortcutRow
            to="/accounting/quotes"
            icon={FileCheck}
            title="Cotizaciones aceptadas"
            description="Descarga el PDF de cada cotización aceptada para tu archivo."
          />
          <ShortcutRow
            to="/accounting/commissions"
            icon={Wallet}
            title="Comisiones por pagar"
            description="Detalle por empleado del ciclo activo, con exportación a CSV."
          />
          <ShortcutRow
            to="/accounting/odoo"
            icon={Download}
            title="Exportar a Odoo"
            description="Genera CSV de clientes, facturas y comisiones listos para importar."
          />
        </ul>
      </section>
    </>
  );
}

function ShortcutRow({ to, icon: Icon, title, description }) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center gap-3 px-5 py-3 hover:bg-ink-50 transition-colors"
      >
        <div className="w-9 h-9 rounded-md bg-ink-100 text-ink-700 flex items-center justify-center flex-shrink-0">
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{title}</div>
          <div className="text-xs text-ink-500 truncate">{description}</div>
        </div>
        <ArrowRight size={14} className="text-ink-300 flex-shrink-0" />
      </Link>
    </li>
  );
}
