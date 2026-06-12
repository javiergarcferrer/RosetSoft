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
import { resolveSales, resolveCommissionsOverview } from '../core/bridge/index.js';

/** How far back the cycle picker reaches (current + 5 closed cycles). */
const CYCLE_HISTORY = 6;

/** Seller-stream payout state — one source for the tables AND the mobile cards. */
function SellerStatus({ e, className = '' }) {
  return e.sellerPaid
    ? <span className={`status-pill status-pill-active ${className}`}>Pagada</span>
    : e.sellerPayable
      ? <span className={`status-pill status-pill-deposito ${className}`}>Por pagar</span>
      : <span className={`text-[11px] text-ink-400 italic ${className}`}>Tras depósito</span>;
}

/** Professional-stream payout state (non-trade). */
function ProStatus({ e, className = '' }) {
  return e.proPaid
    ? <span className={`status-pill status-pill-active ${className}`}>Pagada</span>
    : e.proOwed
      ? <span className={`status-pill status-pill-deposito ${className}`}>Por pagar</span>
      : <span className={`text-[11px] text-ink-400 italic ${className}`}>No exigible</span>;
}

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
  const cycles = useMemo(
    () => Array.from({ length: CYCLE_HISTORY }, (_, i) => cycleEnding(today, -i)),
    [today],
  );
  const [cycleIdx, setCycleIdx] = useState(0); // 0 = current, 1 = previous, …
  const cycle = cycles[cycleIdx];

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

  const overview = useMemo(() => resolveCommissionsOverview(sales), [sales]);

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

      {/* Cycle picker — a select over the payout history (current + the last
          closed cycles), so the full-scope view isn't capped at two windows. */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <Calendar size={15} className="text-ink-400 shrink-0" />
        <select
          className="input w-auto min-w-0"
          value={cycleIdx}
          onChange={(e) => setCycleIdx(Number(e.target.value))}
          aria-label="Ciclo de comisiones"
        >
          {cycles.map((c, i) => (
            <option key={c.end} value={i}>
              {i === 0 ? `Ciclo actual · ${formatCycle(c)}` : formatCycle(c)}
            </option>
          ))}
        </select>
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
            <>
            {/* Mobile: per-sale cards (same fields as the table). */}
            <div className="md:hidden space-y-2">
              {myEntries.map((e) => (
                <div key={e.quote.id} className="card card-pad flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="tabular-nums font-medium text-ink-900">#{e.quote.number ?? '—'}</span>
                    <SellerStatus e={e} />
                  </div>
                  <div className="text-sm text-ink-700 truncate">{e.customer?.name || '—'}</div>
                  <div className="flex items-baseline justify-between text-sm tabular-nums">
                    <span className="text-ink-500">{usd(e.base)} · {e.commissionPct}%</span>
                    <span className="font-semibold text-ink-900">{usd(e.sellerReported)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block card overflow-hidden">
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
                        <td><SellerStatus e={e} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            </>
          )}
        </>
      ) : (
        <div className="space-y-4">
          {/* Full-scope cycle header: both streams summed, paid vs pending. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="card p-4 sm:p-5 flex flex-col gap-1.5">
              <div className="eyebrow-xs tracking-wide text-ink-500">Ventas del ciclo</div>
              <div className="text-xl font-semibold tabular-nums text-ink-900">{overview.salesCount}</div>
              <div className="text-xs text-ink-500 tabular-nums">Base {usd(overview.base)}</div>
            </div>
            <div className="card p-4 sm:p-5 flex flex-col gap-1.5">
              <div className="eyebrow-xs tracking-wide text-ink-500">Comisiones del ciclo</div>
              <div className="text-xl font-semibold tabular-nums text-ink-900">{usd(overview.total.commission)}</div>
              <div className="text-xs text-ink-500 tabular-nums">
                Vend. {usd(overview.seller.commission)} · Prof. {usd(overview.professional.commission)}
              </div>
            </div>
            <div className="card p-4 sm:p-5 flex flex-col gap-1.5">
              <div className="eyebrow-xs tracking-wide text-ink-500">Pagado</div>
              <div className="text-xl font-semibold tabular-nums text-emerald-700">{usd(overview.total.paid)}</div>
              <div className="text-xs text-ink-500 tabular-nums">
                Vend. {usd(overview.seller.paid)} · Prof. {usd(overview.professional.paid)}
              </div>
            </div>
            <div className="card p-4 sm:p-5 flex flex-col gap-1.5">
              <div className="eyebrow-xs tracking-wide text-ink-500">Pendiente</div>
              <div className="text-xl font-semibold tabular-nums text-amber-700">{usd(overview.total.pending)}</div>
              <div className="text-xs text-ink-500 tabular-nums">
                Vend. {usd(overview.seller.pending)} · Prof. {usd(overview.professional.pending)}
              </div>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="card-header">
              <h2>Vendedores</h2>
              <span className="badge">{sales.vendedorRows.length}</span>
            </div>
            {/* Mobile: one stacked row per seller. */}
            <div className="md:hidden divide-y divide-ink-100">
              {sales.vendedorRows.length === 0 ? (
                <div className="px-4 py-8 text-center text-ink-400 text-sm">Sin comisiones en el ciclo.</div>
              ) : sales.vendedorRows.map((r) => (
                <div key={r.user.id} className="px-4 py-3 flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink-900 truncate">{r.user.name}</span>
                    <span className="text-xs text-ink-500 tabular-nums shrink-0">{r.pct}% · {r.count} venta{r.count === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm tabular-nums">
                    <span className="text-ink-500">Base {usd(r.base)}</span>
                    <span className="font-semibold text-ink-900">{usd(r.commission)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs tabular-nums">
                    <span className="text-emerald-700">Pagado {usd(r.paid)}</span>
                    <span className="font-medium text-amber-700">Pendiente {usd(r.pending)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Vendedor</th>
                    <th className="text-right">%</th>
                    <th className="text-right whitespace-nowrap">Ventas</th>
                    <th className="text-right whitespace-nowrap">Base</th>
                    <th className="text-right whitespace-nowrap">Comisión</th>
                    <th className="text-right whitespace-nowrap">Pagado</th>
                    <th className="text-right whitespace-nowrap">Pendiente</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.vendedorRows.length === 0 ? (
                    <tr><td colSpan={7} className="py-8 text-center text-ink-400 text-sm">Sin comisiones en el ciclo.</td></tr>
                  ) : sales.vendedorRows.map((r) => (
                    <tr key={r.user.id} className="hover:bg-ink-50 transition-colors">
                      <td className="font-medium text-ink-900">{r.user.name}</td>
                      <td className="text-right tabular-nums text-ink-500">{r.pct}%</td>
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
              {/* Mobile: one stacked row per professional. */}
              <div className="md:hidden divide-y divide-ink-100">
                {sales.profRows.map((r) => (
                  <div key={r.professional.id} className="px-4 py-3 flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink-900 truncate">{r.professional.name}</span>
                      <span className="text-xs text-ink-500 tabular-nums shrink-0">{r.count} venta{r.count === 1 ? '' : 's'}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm tabular-nums">
                      <span className="text-ink-500">Comisión</span>
                      <span className="font-semibold text-ink-900">{usd(r.commission)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs tabular-nums">
                      <span className="text-emerald-700">Pagado {usd(r.paid)}</span>
                      <span className="font-medium text-amber-700">Pendiente {usd(r.pending)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden md:block overflow-x-auto">
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

          {/* Per-sale detail — every sale in the cycle with BOTH commission
              streams side by side, so the admin can trace each rollup figure
              back to the quote that produced it. */}
          <div className="card overflow-hidden">
            <div className="card-header">
              <h2>Detalle por venta</h2>
              <span className="badge">{sales.entries.length}</span>
            </div>
            {/* Mobile: per-sale cards with both commission streams. */}
            <div className="md:hidden divide-y divide-ink-100">
              {sales.entries.length === 0 ? (
                <div className="px-4 py-8 text-center text-ink-400 text-sm">Sin ventas en el ciclo.</div>
              ) : sales.entries.map((e) => (
                <div key={e.quote.id} className="px-4 py-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Link to={`/quotes/${e.quote.id}`} className="tabular-nums font-medium text-brand-600 hover:text-brand-700">
                      #{e.quote.number ?? '—'}
                    </Link>
                    <span className="text-xs text-ink-500 tabular-nums">Base {usd(e.base)}</span>
                  </div>
                  <div className="text-sm text-ink-700 truncate">{e.customer?.name || '—'}</div>
                  {e.creator && (
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-ink-500 truncate">Vend. {e.creator.name}</span>
                      <span className="whitespace-nowrap tabular-nums">
                        <span className="font-medium text-ink-900">{usd(e.sellerReported)}</span>
                        <SellerStatus e={e} className="ml-2" />
                      </span>
                    </div>
                  )}
                  {e.professional && (e.trade ? (
                    <div className="text-[11px] text-ink-500 italic">
                      Prof. {e.professional.name} · Trade {e.decoratorPct}% ({usd(e.tradeDiscount)})
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-ink-500 truncate">Prof. {e.professional.name}</span>
                      <span className="whitespace-nowrap tabular-nums">
                        <span className="font-medium text-ink-900">{usd(e.proReported)}</span>
                        <ProStatus e={e} className="ml-2" />
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Cotización</th>
                    <th>Cliente</th>
                    <th>Vendedor</th>
                    <th className="text-right whitespace-nowrap">Base</th>
                    <th className="text-right whitespace-nowrap">Com. vendedor</th>
                    <th>Profesional</th>
                    <th className="text-right whitespace-nowrap">Com. profesional</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.entries.length === 0 ? (
                    <tr><td colSpan={7} className="py-8 text-center text-ink-400 text-sm">Sin ventas en el ciclo.</td></tr>
                  ) : sales.entries.map((e) => (
                    <tr key={e.quote.id} className="hover:bg-ink-50 transition-colors">
                      <td className="tabular-nums font-medium">
                        <Link to={`/quotes/${e.quote.id}`} className="text-brand-600 hover:text-brand-700">
                          #{e.quote.number ?? '—'}
                        </Link>
                      </td>
                      <td className="text-ink-700">{e.customer?.name || '—'}</td>
                      <td className="text-ink-700">{e.creator?.name || '—'}</td>
                      <td className="text-right tabular-nums">{usd(e.base)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">
                        {e.creator ? (
                          <>
                            <span className="font-medium text-ink-900">{usd(e.sellerReported)}</span>
                            <SellerStatus e={e} className="ml-2" />
                          </>
                        ) : <span className="text-ink-400">—</span>}
                      </td>
                      <td className="text-ink-700">{e.professional?.name || '—'}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">
                        {!e.professional ? (
                          <span className="text-ink-400">—</span>
                        ) : e.trade ? (
                          <span className="text-[11px] text-ink-500 italic">Trade {e.decoratorPct}% ({usd(e.tradeDiscount)})</span>
                        ) : (
                          <>
                            <span className="font-medium text-ink-900">{usd(e.proReported)}</span>
                            <ProStatus e={e} className="ml-2" />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {(role === 'admin' || role === 'accounting') && (
            <p className="text-xs text-ink-400">
              Marca pagos y exporta desde <Link to="/accounting/ventas" className="text-brand-600 hover:text-brand-700 underline underline-offset-2">Contabilidad → Ventas y comisiones</Link>.
            </p>
          )}
        </div>
      )}
    </>
  );
}
