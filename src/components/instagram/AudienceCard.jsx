// Audience card — a "¿quién es tu audiencia?" summary strip up top (the three
// figures a dealer acts on: género dominante, edad principal, mercado local),
// then the gender donut and ONE switchable bar list (edad / países / ciudades)
// so the card stays compact instead of stacking three long lists. Every bar
// carries a direct % label, and the accent is the single brand hue on tokens
// (identity work is done by position + label, never by a per-dimension
// rainbow — and token colors stay correct in dark mode).
import { useMemo, useState } from 'react';
import { Instagram } from 'lucide-react';
import { Donut, BulletBar, Legend } from '../charts/MiniCharts.jsx';
import { fmt } from './chrome.jsx';

const ACCENT = 'rgb(var(--brand-500))'; // token-backed: correct in both themes

// A ranked horizontal-bar list (age / countries / cities) — label, bar, value.
function BarList({ rows, max }) {
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <div className="w-24 sm:w-28 shrink-0 truncate text-sm text-ink-700" title={r.label}>{r.label}</div>
          <div className="flex-1 min-w-0"><BulletBar value={r.value} max={max} color={ACCENT} /></div>
          <div className="w-12 shrink-0 text-right tabular-nums text-xs text-ink-500">
            {r.pct != null ? `${r.pct}%` : fmt(r.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

// One figure of the summary strip — value first (it's what the eye scans for).
function WhoStat({ value, label }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-display text-base font-semibold text-ink-900">{value}</div>
      <div className="truncate text-[11px] text-ink-400">{label}</div>
    </div>
  );
}

export default function AudienceCard({ audience, errors, kpis = null }) {
  const [dim, setDim] = useState('age');
  const dims = useMemo(() => [
    { id: 'age', label: 'Edad', rows: audience.age },
    { id: 'countries', label: 'Países', rows: audience.topCountries },
    { id: 'cities', label: 'Ciudades', rows: audience.topCities },
  ].filter((d) => d.rows.length > 0), [audience]);
  const active = dims.find((d) => d.id === dim) || dims[0] || null;
  const max = active ? Math.max(1, ...active.rows.map((r) => r.value)) : 1;

  // The promoted summary figures — only the ones the data actually supports.
  const conc = kpis?.audienceConcentration || null;
  const topGender = audience.gender[0] || null;
  const who = [
    topGender ? { value: `${topGender.label} ${topGender.pct}%`, label: 'género dominante' } : null,
    conc?.dominantAge ? { value: `${conc.dominantAge.label} años`, label: conc.dominantAge.pct != null ? `edad principal · ${conc.dominantAge.pct}%` : 'edad principal' } : null,
    conc?.homeMarketPct != null
      ? { value: `${conc.homeMarketPct}% RD`, label: 'mercado local' }
      : (conc?.topCountry ? { value: `${conc.topCountry.label}${conc.topCountry.pct != null ? ` ${conc.topCountry.pct}%` : ''}`, label: 'principal país' } : null),
  ].filter(Boolean);

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
            {who.length > 0 && (
              <div className="rounded-xl bg-ink-50 px-3.5 py-2.5">
                <div className="text-[11px] uppercase tracking-wider text-ink-400">¿Quién es tu audiencia?</div>
                <div className="mt-1.5 grid grid-cols-3 gap-3">
                  {who.slice(0, 3).map((w) => <WhoStat key={w.label} value={w.value} label={w.label} />)}
                </div>
                {conc?.top3CountryPct != null && (
                  <div className="mt-1.5 text-[11px] text-ink-400">
                    El top 3 de países concentra <b className="font-medium tabular-nums text-ink-600">{conc.top3CountryPct}%</b> de la audiencia visible.
                  </div>
                )}
              </div>
            )}
            {audience.gender.length > 0 && (
              <div className="flex items-center gap-4">
                <Donut
                  size={96}
                  thickness={13}
                  segments={audience.gender.map((g) => ({ value: g.value, color: g.color }))}
                  ariaLabel={`Género: ${audience.gender.map((g) => `${g.label} ${g.pct}%`).join(', ')}`}
                >
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
                <BarList rows={active.rows} max={max} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
