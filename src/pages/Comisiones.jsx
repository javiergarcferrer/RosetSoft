import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Calendar } from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ListLoading from '../components/ListLoading.jsx';
import { formatMoney } from '../lib/format.js';
import { cycleEnding, formatCycle } from '../lib/commissionCycle.js';
import { computeTotals, lineForTotals } from '../lib/pricing.js';
import { isPricedLine } from '../lib/constants.js';
import { resolveSales } from '../core/bridge/index.js';

/**
 * Comisiones — the bridge surface between a CRM sale and its accounting payout.
 * Role-adaptive: an employee sees only their own earned commissions; admins and
 * accounting see every seller + professional. Read-only — payouts are marked in
 * the accounting workspace (Ventas y comisiones). Commissions are computed on
 * the USD taxable base.
 */
export default function Comisiones() {
  const { profileId, profiles, currentProfile } = useApp();
  const role = currentProfile?.role;
  const allowed = role === 'admin' || role === 'employee' || role === 'accounting';
  const ownOnly = role === 'employee';

  const today = useMemo(() => new Date(), []);
  const cycles = useMemo(() => ({ curr: cycleEnding(today, 0), prev: cycleEnding(today, -1) }), [today]);
  const [mode, setMode] = useState('current'); // 'current' | 'previous'
  const cycle = mode === 'current' ? cycles.curr : cycles.prev;

  const quotesQ = useLiveQueryStatus(() => db.quotes.where('profileId').equals(profileId || '').toArray(), [profileId], []);
  const linesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(profileId || '').toArray(), [profileId], []);
  const professionalsQ = useLiveQueryStatus(() => db.professionals.where('profileId').equals(profileId || '').toArray(), [profileId], []);
  const loaded = quotesQ.loaded && linesQ.loaded && customersQ.loaded;

  const linesByQuote = useMemo(() => {
    const m = new Map();
    for (const ln of linesQ.data) { if (!m.has(ln.quoteId)) m.set(ln.quoteId, []); m.get(ln.quoteId).push(ln); }
    return m;
  }, [linesQ.data]);
  const customerById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const professionalById = useMemo(() => new Map(professionalsQ.data.map((p) => [p.id, p])), [professionalsQ.data]);
  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  function totalsFor(q) {
    const rows = (linesByQuote.get(q.id) || []).filter(isPricedLine).map(lineForTotals);
    return computeTotals(rows, q);
  }

  const sales = useMemo(
    () => resolveSales({ quotes: quotesQ.data, cycle, customerById, profileById, professionalById, totalsFor }),
    [quotesQ.data, cycle, customerById, profileById, professionalById, linesByQuote],
  );

  const myEntries = useMemo(
    () => sales.entries.filter((e) => e.creator?.id === currentProfile?.id),
    [sales.entries, currentProfile],
  );
  const myRow = useMemo(
    () => sales.vendedorRows.find((r) => r.user?.id === currentProfile?.id),
    [sales.vendedorRows, currentProfile],
  );

  if (!allowed) {
    return (
      <>
        <PageHeader title="Comisiones" subtitle=" " />
        <EmptyState icon={Wallet} title="Sin acceso" description="No tienes comisiones que mostrar." />
      </>
    );
  }

  const usd = (v) => formatMoney(v, 'USD');

  return (
    <>
      <PageHeader title="Comisiones"
        subtitle={ownOnly ? 'Tus comisiones por ciclo' : 'Comisiones de vendedores y profesionales'} />

      <div className="flex items-center gap-2 mb-4">
        <Calendar size={15} className="text-ink-400" />
        <button type="button" onClick={() => setMode('current')} className={`text-sm px-3 py-1.5 rounded-lg ${mode === 'current' ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>Ciclo actual</button>
        <button type="button" onClick={() => setMode('previous')} className={`text-sm px-3 py-1.5 rounded-lg ${mode === 'previous' ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>Anterior</button>
        <span className="text-sm text-ink-500 ml-2">{formatCycle(cycle)}</span>
      </div>

      {!loaded ? <ListLoading /> : ownOnly ? (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4 max-w-2xl">
            <div className="card p-4"><div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Comisión del ciclo</div><div className="text-xl font-semibold tabular-nums">{usd(myRow?.commission || 0)}</div></div>
            <div className="card p-4"><div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Pagado</div><div className="text-xl font-semibold tabular-nums text-emerald-700">{usd(myRow?.paid || 0)}</div></div>
            <div className="card p-4"><div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Pendiente</div><div className="text-xl font-semibold tabular-nums">{usd(myRow?.pending || 0)}</div></div>
          </div>
          {myEntries.length === 0 ? (
            <EmptyState icon={Wallet} title="Sin comisiones en el ciclo" description="Tus ventas con comisión aparecerán aquí." />
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                  <tr><th className="text-left py-2 px-3">Cotización</th><th className="text-left py-2 px-3">Cliente</th><th className="text-right py-2 px-3">Base</th><th className="text-right py-2 px-3">%</th><th className="text-right py-2 px-3">Comisión</th><th className="text-left py-2 px-3">Estado</th></tr>
                </thead>
                <tbody>
                  {myEntries.map((e) => (
                    <tr key={e.quote.id} className="border-t border-ink-50">
                      <td className="py-1.5 px-3 tabular-nums">#{e.quote.number ?? '—'}</td>
                      <td className="py-1.5 px-3">{e.customer?.name || '—'}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{usd(e.base)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{e.commissionPct}%</td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium">{usd(e.sellerReported)}</td>
                      <td className="py-1.5 px-3">{e.sellerPaid ? <span className="text-emerald-700 text-xs">Pagada</span> : e.sellerPayable ? <span className="text-amber-700 text-xs">Por pagar</span> : <span className="text-ink-400 text-xs">Tras depósito</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="px-4 pt-3"><h2 className="eyebrow font-semibold text-ink-600">Vendedores</h2></div>
            <table className="w-full text-sm mt-2">
              <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                <tr><th className="text-left py-2 px-3">Vendedor</th><th className="text-right py-2 px-3">Ventas</th><th className="text-right py-2 px-3">Base</th><th className="text-right py-2 px-3">Comisión</th><th className="text-right py-2 px-3">Pagado</th><th className="text-right py-2 px-3">Pendiente</th></tr>
              </thead>
              <tbody>
                {sales.vendedorRows.length === 0 ? (
                  <tr><td colSpan={6} className="py-6 text-center text-ink-400 text-sm">Sin comisiones en el ciclo.</td></tr>
                ) : sales.vendedorRows.map((r) => (
                  <tr key={r.user.id} className="border-t border-ink-50">
                    <td className="py-1.5 px-3 font-medium">{r.user.name}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{r.count}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{usd(r.base)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium">{usd(r.commission)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-emerald-700">{usd(r.paid)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{usd(r.pending)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sales.profRows.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 pt-3"><h2 className="eyebrow font-semibold text-ink-600">Profesionales</h2></div>
              <table className="w-full text-sm mt-2">
                <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                  <tr><th className="text-left py-2 px-3">Profesional</th><th className="text-right py-2 px-3">Ventas</th><th className="text-right py-2 px-3">Comisión</th><th className="text-right py-2 px-3">Pagado</th><th className="text-right py-2 px-3">Pendiente</th></tr>
                </thead>
                <tbody>
                  {sales.profRows.map((r) => (
                    <tr key={r.professional.id} className="border-t border-ink-50">
                      <td className="py-1.5 px-3 font-medium">{r.professional.name}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{r.count}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium">{usd(r.commission)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-emerald-700">{usd(r.paid)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{usd(r.pending)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(role === 'admin' || role === 'accounting') && (
            <p className="text-xs text-ink-400">
              Marca pagos y exporta desde <Link to="/accounting" className="underline hover:text-ink-700">Contabilidad → Ventas y comisiones</Link>.
            </p>
          )}
        </div>
      )}
    </>
  );
}
