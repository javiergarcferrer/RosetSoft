// AdsImpact — the "¿qué está comprando ese gasto?" side of the Anuncios board.
// Three layers, all pre-derived by the VMs (resolveSocialPulse.kpis +
// resolveAdsSalesWeeks): the 7-day efficiency chips with HONEST deltas (null
// base → no chip, never a fake 0%), the spend→clicks→results funnel with the
// conversion between steps written out, and the spend-vs-quotes weekly view —
// deliberately TWO stacked charts sharing one x-axis instead of a dual-axis
// chart (money and counts never share a y-scale; the reader compares shapes).
import { TrendingUp, Filter } from 'lucide-react';
import { fmt, fmtCompact } from './chrome.jsx';
import { DeltaChip, FunnelStages, Columns, PairedColumns } from './IgCharts.jsx';

const money = (n) => Number(n || 0).toLocaleString('es-DO', { maximumFractionDigits: 0 });
const money2 = (n) => Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// One efficiency figure + its honest delta chip.
function EffStat({ label, value, delta, goodIsUp, deltaTitle }) {
  return (
    <div className="rounded-lg bg-ink-50 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="font-display text-base font-semibold text-ink-900">{value}</span>
        <DeltaChip value={delta} goodIsUp={goodIsUp} title={deltaTitle} />
      </div>
    </div>
  );
}

export default function AdsImpact({ kpis = null, adCurrency = null, weeks = null }) {
  const k = kpis || {};
  const cur = adCurrency ? ` ${adCurrency}` : '';
  const hasFunnel = (k.impressions7 || 0) > 0;
  const weekRows = (weeks || []).map((w) => ({ label: w.label, spend: w.spend, created: w.created, accepted: w.accepted }));
  const hasWeeks = weekRows.length > 0 && weekRows.some((w) => w.spend > 0 || w.created > 0 || w.accepted > 0);
  const resultsLabel = k.resultsLabel || 'resultados';

  if (!hasFunnel && !hasWeeks) {
    return (
      <div className="card card-pad text-sm text-ink-400">
        Cuando tus anuncios registren entrega verás aquí su embudo (impresiones → clics → {resultsLabel})
        y el gasto semanal junto a las cotizaciones del negocio.
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="flex items-center gap-2 font-medium"><TrendingUp size={15} /> Impacto · 7 días</span>
        {k.spend7 != null && (
          <span className="flex items-center gap-1.5 text-xs text-ink-400 tabular-nums">
            {money(k.spend7)}{cur}
            <DeltaChip value={k.spendDeltaPct} goodIsUp={null} title="gasto vs 7 días anteriores" />
          </span>
        )}
      </div>
      <div className="card-pad space-y-4">
        {hasFunnel ? (
          <>
            {/* efficiency chips — value + honest delta (7d vs 7d anteriores) */}
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              <EffStat
                label="CPC"
                value={k.cpc7 != null ? `${money2(k.cpc7)}${cur}` : '—'}
                delta={k.cpcDeltaPct}
                goodIsUp={false}
                deltaTitle="vs 7 días anteriores"
              />
              <EffStat
                label="CTR"
                value={k.ctr7Pct != null ? `${k.ctr7Pct.toLocaleString('es-DO', { maximumFractionDigits: 2 })}%` : '—'}
                delta={k.ctrDeltaPct}
                goodIsUp
                deltaTitle="vs 7 días anteriores"
              />
              <EffStat
                label="Costo/resultado"
                value={k.costPerResult7 != null ? `${money2(k.costPerResult7)}${cur}` : '—'}
                delta={k.costPerResultDeltaPct}
                goodIsUp={false}
                deltaTitle="vs 7 días anteriores"
              />
            </div>

            {/* the funnel — every step direct-labeled, conversions spelled out */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
                <Filter size={11} /> Embudo · 7 días
              </div>
              <FunnelStages
                format={fmtCompact}
                stages={[
                  { label: 'Impresiones', value: k.impressions7 || 0 },
                  { label: 'Clics', value: k.clicks7 || 0, convPct: k.ctr7Pct, convLabel: 'CTR' },
                  ...(k.resultsLabel ? [{
                    label: resultsLabel.charAt(0).toUpperCase() + resultsLabel.slice(1),
                    value: k.results7 || 0,
                    convPct: k.clickToResult7Pct,
                    convLabel: 'de los clics',
                  }] : []),
                ]}
              />
              {k.results7 > 0 && (
                <div className="mt-1.5 text-xs text-ink-500 tabular-nums">
                  {fmt(k.results7)} {resultsLabel} esta semana
                  {k.costPerResult7 != null ? <> · {money2(k.costPerResult7)}{cur} cada uno</> : null}
                  {' '}<DeltaChip value={k.resultsDeltaPct} goodIsUp title="vs 7 días anteriores" />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="text-sm text-ink-400">Sin entrega de anuncios en los últimos 7 días.</div>
        )}

        {/* spend vs quotes — two charts, one x-axis, no dual-axis trickery */}
        {hasWeeks && (
          <div className="border-t border-ink-100 pt-3">
            <div className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-400">
              Inversión vs. cotizaciones · semanas (lun–dom)
            </div>
            <Columns
              data={weekRows.map((w) => ({ label: w.label, value: w.spend }))}
              barClass="bg-brand-500"
              height={72}
              format={(v) => money(v)}
              ariaLabel={`Gasto semanal en anuncios${cur}`}
            />
            <div className="mb-1 mt-0.5 text-right text-[10px] text-ink-400">gasto{cur}</div>
            <PairedColumns
              data={weekRows.map((w) => ({ label: w.label, a: w.created, b: w.accepted }))}
              series={[
                { label: 'Cotizaciones creadas', barClass: 'bg-ink-400' },
                { label: 'Aceptadas', barClass: 'bg-brand-600' },
              ]}
              height={64}
              format={(v) => fmt(v)}
              ariaLabel="Cotizaciones por semana"
            />
            <p className="mt-2 text-[11px] leading-snug text-ink-400">
              Misma semana, dos escalas separadas — compara la forma, no la altura: el gasto no
              garantiza cotizaciones, pero una desconexión sostenida sí es señal para ajustar.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
