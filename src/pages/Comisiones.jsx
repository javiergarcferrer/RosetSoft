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

      {/* Cycle picker — same segmented-control shape as the Mías/Equipo
          ScopeToggle so the app has ONE two-state switch vocabulary. */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <Calendar size={15} className="text-ink-400 shrink-0" />
        <div className="inline-flex rounded-md border border-ink-200 overflow-hidden text-sm font-medium select-none">
          <button
            type="button"
            onClick={() => setMode('current')}
            className={mode === 'current'
              ? 'px-3 py-1.5 min-h-9 coarse:min-h-11 bg-ink-900 text-ink-50'
              : 'px-3 py-1.5 min-h-9 coarse:min-h-11 text-ink-600 hover:bg-ink-100 active:bg-ink-200 transition-colors'}
          >
            Ciclo actual
          </button>
          <button
            type="button"
            onClick={() => setMode('previous')}
            className={mode === 'previous'
              ? 'px-3 py-1.5 min-h-9 coarse:min-h-11 bg-ink-900 text-ink-50'
              : 'px-3 py-1.5 min-h-9 coarse:min-h-11 text-ink-600 hover:bg-ink-100 active:bg-ink-200 transition-colors'}
          >
            Anterior
          </button>
        </div>
        <span className="text-sm text-ink-500 ml-1 tabular-nums">{formatCycle(cycle)}</span>
      </div>

      {!loaded ? <ListLoading /> : ownOnly ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5 max-w-2xl">
            <div className="card p-4 sm:p-5 flex flex-col gap-1.5">
              <div className="eyebrow-xs tracking-wide text-ink-500">Comisión del ciclo</div>
              <div className="text-xl font-semibold tabular-nums text-ink-900">{usd(myRow?.commission || 0)}</div>
            </div>
            <div className="card p-4 sm:p-5 flex flex-col gap-1.5">
              <div className="eyebrow-xs tracking-wide text-ink-500">Pagado</div>
              <div className="text-xl font-semibold tabular-nums text-emerald-700">{usd(myRow?.paid || 0)}</div>
            </div>
            <div className="card p-4 sm:p-5 flex flex-col gap-1.5">
              <div className="eyebrow-xs tracking-wide text-ink-500">Pendiente</div>
              <div className="text-xl font-semibold tabular-nums text-amber-700">{usd(myRow?.pending || 0)}</div>
            </div>
          </div>
          {myEntries.length === 0 ? (
            <EmptyState icon={Wallet} title="Sin comisiones en el ciclo" description="Tus ventas con comisión aparecerán aquí." />
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Cotización</th>
                      <th>Cliente</th>
                      <th className="text-right whitespace-nowrap">Base</th>
                      <th className="text-right">%</th>
                      <th className="text-right whitespace-nowrap">Comisión</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myEntries.map((e) => (
                      <tr key={e.quote.id} className="hover:bg-ink-50 transition-colors">
                        <td className="tabular-nums font-medium text-ink-900">#{e.quote.number ?? '—'}</td>
                        <td className="text-ink-700">{e.customer?.name || '—'}</td>
                        <td className="text-right tabular-nums">{usd(e.base)}</td>
                        <td className="text-right tabular-nums">{e.commissionPct}%</td>
                        <td className="text-right tabular-nums font-semibold text-ink-900">{usd(e.sellerReported)}</td>
                        <td>
                          {e.sellerPaid
                            ? <span className="status-pill status-pill-active">Pagada</span>
                            : e.sellerPayable
                              ? <span className="status-pill status-pill-deposito">Por pagar</span>
                              : <span className="text-[11px] text-ink-400 italic">Tras depósito</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="card-header">
              <h2>Vendedores</h2>
              <span className="badge">{sales.vendedorRows.length}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Vendedor</th>
                    <th className="text-right whitespace-nowrap">Ventas</th>
                    <th className="text-right whitespace-nowrap">Base</th>
                    <th className="text-right whitespace-nowrap">Comisión</th>
                    <th className="text-right whitespace-nowrap">Pagado</th>
                    <th className="text-right whitespace-nowrap">Pendiente</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.vendedorRows.length === 0 ? (
                    <tr><td colSpan={6} className="py-8 text-center text-ink-400 text-sm">Sin comisiones en el ciclo.</td></tr>
                  ) : sales.vendedorRows.map((r) => (
                    <tr key={r.user.id} className="hover:bg-ink-50 transition-colors">
                      <td className="font-medium text-ink-900">{r.user.name}</td>
                      <td className="text-right tabular-nums">{r.count}</td>
                      <td className="text-right tabular-nums">{usd(r.base)}</td>
                      <td className="text-right tabular-nums font-semibold">{usd(r.commission)}</td>
                      <td className="text-right tabular-nums text-emerald-700">{usd(r.paid)}</td>
                      <td className="text-right tabular-nums font-medium text-amber-700">{usd(r.pending)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {sales.profRows.length > 0 && (
            <div className="card overflow-hidden">
              <div className="card-header">
                <h2>Profesionales</h2>
                <span className="badge">{sales.profRows.length}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Profesional</th>
                      <th className="text-right whitespace-nowrap">Ventas</th>
                      <th className="text-right whitespace-nowrap">Comisión</th>
                      <th className="text-right whitespace-nowrap">Pagado</th>
                      <th className="text-right whitespace-nowrap">Pendiente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.profRows.map((r) => (
                      <tr key={r.professional.id} className="hover:bg-ink-50 transition-colors">
                        <td className="font-medium text-ink-900">{r.professional.name}</td>
                        <td className="text-right tabular-nums">{r.count}</td>
                        <td className="text-right tabular-nums font-semibold">{usd(r.commission)}</td>
                        <td className="text-right tabular-nums text-emerald-700">{usd(r.paid)}</td>
                        <td className="text-right tabular-nums font-medium text-amber-700">{usd(r.pending)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(role === 'admin' || role === 'accounting') && (
            <p className="text-xs text-ink-400">
              Marca pagos y exporta desde <Link to="/accounting" className="text-brand-600 hover:text-brand-700 underline underline-offset-2">Contabilidad → Ventas y comisiones</Link>.
            </p>
          )}
        </div>
      )}
    </>
  );
}
