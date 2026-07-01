// Audience card — gender donut up top, then ONE switchable bar list (edad /
// países / ciudades) so the card stays compact instead of stacking three long
// lists. Each dimension scales to its own max so the leading bar fills the row.
import { useMemo, useState } from 'react';
import { Instagram } from 'lucide-react';
import { Donut, BulletBar, Legend } from '../charts/MiniCharts.jsx';
import { fmt } from './chrome.jsx';

// A ranked horizontal-bar list (age / countries / cities) — label, bar, value.
function BarList({ rows, max, accent = '#c96a2a' }) {
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <div className="w-24 sm:w-28 shrink-0 truncate text-sm text-ink-700" title={r.label}>{r.label}</div>
          <div className="flex-1 min-w-0"><BulletBar value={r.value} max={max} color={accent} /></div>
          <div className="w-12 shrink-0 text-right tabular-nums text-xs text-ink-500">
            {r.pct != null ? `${r.pct}%` : fmt(r.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AudienceCard({ audience, errors, kpis = null }) {
  const [dim, setDim] = useState('age');
  const dims = useMemo(() => [
    { id: 'age', label: 'Edad', rows: audience.age, accent: '#c96a2a' },
    { id: 'countries', label: 'Países', rows: audience.topCountries, accent: '#3b3830' },
    { id: 'cities', label: 'Ciudades', rows: audience.topCities, accent: '#6b8f71' },
  ].filter((d) => d.rows.length > 0), [audience]);
  const active = dims.find((d) => d.id === dim) || dims[0] || null;
  const max = active ? Math.max(1, ...active.rows.map((r) => r.value)) : 1;

  return (
    <div className="card">
      <div className="card-header"><span className="flex items-center gap-2 font-medium"><Instagram size={15} /> Audiencia</span></div>
      <div className="card-pad">
        {!audience.hasData ? (
          <div className="text-sm text-ink-400">
            Las estadísticas de audiencia aparecen al superar 100 seguidores
            {errors?.demo_gender ? ' (Meta aún no las devuelve).' : '.'}
          </div>
        ) : (
          <div className="space-y-4">
            {audience.gender.length > 0 && (
              <div className="flex items-center gap-4">
                <Donut size={96} thickness={13} segments={audience.gender.map((g) => ({ value: g.value, color: g.color }))}>
                  <span className="text-[10px] uppercase tracking-wider text-ink-400">Género</span>
                </Donut>
                <div className="min-w-0">
                  <Legend items={audience.gender.map((g) => ({ label: `${g.label} ${g.pct}%`, color: g.color }))} />
                </div>
              </div>
            )}
            {active && (
              <>
                {dims.length > 1 ? (
                  <div className="inline-flex w-full rounded-full border border-ink-200 bg-ink-100 p-1 text-xs" role="tablist" aria-label="Desglose de audiencia">
                    {dims.map((d) => {
                      const on = active.id === d.id;
                      return (
                        <button
                          key={d.id}
                          type="button"
                          role="tab"
                          aria-selected={on}
                          onClick={() => setDim(d.id)}
                          className={`flex-1 rounded-full px-3 py-1.5 font-medium transition-colors ${on ? 'bg-surface text-brand-700 shadow-sm ring-1 ring-black/5' : 'text-ink-500 hover:text-ink-800'}`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="eyebrow-xs">{active.label}</div>
                )}
                <BarList rows={active.rows} max={max} accent={active.accent} />
              </>
            )}
            {kpis?.audienceConcentration && (kpis.audienceConcentration.homeMarketPct != null || kpis.audienceConcentration.dominantAge) && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-ink-100 pt-3 text-xs text-ink-500">
                {kpis.audienceConcentration.homeMarketPct != null && (
                  <span>Rep. Dominicana <b className="tabular-nums text-ink-800">{kpis.audienceConcentration.homeMarketPct}%</b></span>
                )}
                {kpis.audienceConcentration.top3CountryPct != null && (
                  <span>Top 3 países <b className="tabular-nums text-ink-800">{kpis.audienceConcentration.top3CountryPct}%</b></span>
                )}
                {kpis.audienceConcentration.dominantAge && (
                  <span>Edad principal <b className="tabular-nums text-ink-800">{kpis.audienceConcentration.dominantAge.label}</b></span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
