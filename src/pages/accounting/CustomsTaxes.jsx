import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ship } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import PeriodNav from '../../components/accounting/PeriodNav.jsx';
import RowCards from '../../components/RowCards.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveCustomsTaxes, resolvePeriod } from '../../core/accounting/index.js';

/** One KPI tile of the customs-tax band. */
function Stat({ label, value, accent, sub }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-surface px-3 py-2.5 shadow-xs min-w-0">
      <div className="eyebrow text-ink-400 truncate">{label}</div>
      <div className={`text-base font-semibold tabular-nums whitespace-nowrap ${accent || 'text-ink-800'}`}>{value}</div>
      {sub && <div className="text-[11px] text-ink-400 truncate">{sub}</div>}
    </div>
  );
}

/**
 * Impuestos de aduana — the DGA customs-tax report for a period: the aranceles
 * (gravamen + ISC) and the recoverable ITBIS aduanal liquidated across every
 * posted expediente whose liquidación lands in the window, so the accountant
 * can reconcile duties + the input ITBIS credit against the DGA. Read-only over
 * the expediente Model (resolveCustomsTaxes); each row drills into its file.
 */
export default function CustomsTaxes() {
  const { profileId } = useApp();
  const scope = profileId || 'team';
  const navigate = useNavigate();

  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = expedientesQ.loaded && suppliersQ.loaded;

  // One selected period (mes/trimestre/año, steppable) — the same control the
  // dashboard uses, so the two agree on what "este período" means.
  const [periodSel, setPeriodSel] = useState({ kind: 'month', ref: Date.now() });
  const period = useMemo(() => resolvePeriod(periodSel), [periodSel]);

  const report = useMemo(() => resolveCustomsTaxes({
    expedientes: expedientesQ.data, suppliers: suppliersQ.data,
    start: period.start, end: period.end,
  }), [expedientesQ.data, suppliersQ.data, period]);

  const { rows, totals, count } = report;

  return (
    <AccountingGate title="Impuestos de aduana">
      <PageHeader
        title="Impuestos de aduana"
        subtitle={`Aranceles e ITBIS aduanal liquidados · ${period.label}`}
        actions={<PeriodNav kind={periodSel.kind} refMs={periodSel.ref} onChange={setPeriodSel} />}
      />

      {!loaded ? <ListLoading /> : (
        <div className="space-y-4 min-w-0">
          {/* KPI band — the DGA tax stack over the period's liquidated expedientes. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 min-w-0">
            <Stat label="CIF (valor en aduana)" value={formatDop(totals.cif)} />
            <Stat label="Gravamen arancelario" value={formatDop(totals.gravamen)} />
            <Stat label="ISC / Selectivo" value={formatDop(totals.selectivo)} />
            <Stat label="ITBIS aduanal" value={formatDop(totals.itbis)} accent="text-sky-700" sub="al crédito fiscal" />
            <Stat label="Costo en destino" value={formatDop(totals.landed)} accent="text-emerald-700" />
          </div>

          {count === 0 ? (
            <EmptyState icon={Ship} title="Sin expedientes liquidados"
              description={`Ningún expediente fue contabilizado en ${period.label}.`} />
          ) : (
            <>
              {/* Mobile */}
              <div className="md:hidden">
                <RowCards
                  rows={rows.map((r) => ({
                    key: r.id,
                    to: `/accounting/importaciones/${r.id}`,
                    title: <>{r.number != null && <span className="tabular-nums mr-1.5">#{r.number}</span>}{r.supplierName || '—'}</>,
                    right: formatDop(r.landed),
                    sub: <><span className="tabular-nums">{formatDate(r.date)}</span>{r.bl ? ` · BL ${r.bl}` : ''}</>,
                    kv: [
                      ['CIF', formatDop(r.cif)],
                      ['Gravamen', formatDop(r.gravamen)],
                      ['ISC', formatDop(r.selectivo)],
                      ['ITBIS aduanal', formatDop(r.itbis)],
                    ],
                  }))}
                  footer={[
                    ['Expedientes', count],
                    ['Gravamen', formatDop(totals.gravamen)],
                    ['ITBIS aduanal', formatDop(totals.itbis)],
                    ['Costo destino', formatDop(totals.landed)],
                  ]}
                />
              </div>

              {/* Desktop */}
              <div className="hidden md:block card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="table min-w-[820px]">
                    <thead>
                      <tr>
                        <th className="whitespace-nowrap">Fecha</th>
                        <th className="whitespace-nowrap">#</th>
                        <th>Proveedor</th>
                        <th className="whitespace-nowrap">BL</th>
                        <th className="text-right whitespace-nowrap">CIF</th>
                        <th className="text-right whitespace-nowrap">Gravamen</th>
                        <th className="text-right whitespace-nowrap">ISC</th>
                        <th className="text-right whitespace-nowrap">ITBIS aduanal</th>
                        <th className="text-right whitespace-nowrap">Costo destino</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} onClick={() => navigate(`/accounting/importaciones/${r.id}`)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/accounting/importaciones/${r.id}`); } }}
                          tabIndex={0}
                          className="cursor-pointer hover:bg-ink-50 transition-colors focus-visible:bg-ink-50 focus-visible:outline-none">
                          <td className="text-ink-500 whitespace-nowrap">{formatDate(r.date)}</td>
                          <td className="tabular-nums text-ink-500 whitespace-nowrap">{r.number != null ? `#${r.number}` : '—'}</td>
                          <td className="min-w-0">{r.supplierName || '—'}</td>
                          <td className="font-mono text-xs text-ink-500 whitespace-nowrap">{r.bl || '—'}</td>
                          <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.cif)}</td>
                          <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.gravamen)}</td>
                          <td className="text-right tabular-nums whitespace-nowrap text-ink-500">{formatDop(r.selectivo)}</td>
                          <td className="text-right tabular-nums whitespace-nowrap text-sky-700">{formatDop(r.itbis)}</td>
                          <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(r.landed)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-ink-200 font-semibold bg-ink-50">
                        <td colSpan={4}>{count} expediente{count === 1 ? '' : 's'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(totals.cif)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(totals.gravamen)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(totals.selectivo)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap text-sky-700">{formatDop(totals.itbis)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(totals.landed)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <p className="text-xs text-ink-400 max-w-2xl">
                Gravamen y selectivo (ISC) capitalizan al costo en destino; el ITBIS aduanal es
                crédito fiscal recuperable que se arrastra a la liquidación de ITBIS (IT-1) — no
                forma parte del costo. Sólo se incluyen expedientes contabilizados (no borradores).
              </p>
            </>
          )}
        </div>
      )}
    </AccountingGate>
  );
}
