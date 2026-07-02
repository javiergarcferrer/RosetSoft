// Shared chrome for the Instagram command center — the small primitives the
// page and its section cards reuse: number formatters, the KPI tile, and the
// live-status pill. Kept here as the single source so the surfaces can't drift.
import { RefreshCw } from 'lucide-react';

export const fmt = (n) => Number(n || 0).toLocaleString('es-DO');
export const pctFmt = (n) => (n == null ? '—' : `${n.toLocaleString('es-DO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

// Compact figure for dense chart labels/chips: 12,4 k · 1,2 M. Full precision
// below 10 000 (where the exact number still reads at a glance).
export const fmtCompact = (n) => {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toLocaleString('es-DO', { maximumFractionDigits: 1 })} M`;
  if (abs >= 10_000) return `${(v / 1e3).toLocaleString('es-DO', { maximumFractionDigits: 1 })} k`;
  return v.toLocaleString('es-DO');
};

// "hace 12 s" → "hace 3 min" → "hace 2 h". Drives the live freshness pill.
export const freshLabel = (ms, now) => {
  if (!ms) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 4) return 'ahora mismo';
  if (s < 60) return `hace ${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.round(min / 60)} h`;
};

// A KPI tile — the analytics layer's material figure. `delta` takes a rendered
// chip (e.g. <DeltaChip/>) so the tile itself stays dumb. Display-size values
// use proportional figures (tabular-nums is for aligned columns, not heroes).
export function Stat({ label, value, sub, tone, delta = null }) {
  return (
    <div className="stat-card p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`font-display text-2xl font-semibold ${tone || 'text-ink-900'}`}>{value}</span>
        {delta}
      </div>
      {sub && <div className="text-xs text-ink-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// Live-status pill — a pulsing dot + ticking freshness label reads as a passive
// "this is live" signal; it's still tappable to force a refresh (and shows the
// spinner on hover/while fetching), but it no longer looks like a chore.
export function LivePill({ loading, hasData, error, sinceLabel, onRefresh }) {
  // A failed poll only counts as "degraded" when there's nothing on screen;
  // with data still showing, it's just a momentary reconnect.
  const stale = error && hasData;
  const dot = stale ? 'bg-amber-500' : 'bg-emerald-500';
  const text = loading && !hasData
    ? 'Conectando…'
    : stale
      ? 'Reconectando…'
      : loading
        ? 'Actualizando…'
        : `En vivo${sinceLabel ? ` · ${sinceLabel}` : ''}`;
  return (
    <button
      type="button"
      onClick={onRefresh}
      title="Datos en vivo — toca para actualizar ahora"
      className="group inline-flex items-center gap-2 rounded-full border border-ink-200 bg-surface px-2.5 py-1 text-xs text-ink-500 transition-colors hover:border-ink-300 hover:text-ink-800"
    >
      <span className="relative flex h-2 w-2">
        {!stale && <span className={`absolute inline-flex h-full w-full rounded-full ${dot} opacity-60 animate-ping`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      <span className="tabular-nums">{text}</span>
      <RefreshCw size={12} className={`transition-opacity ${loading ? 'animate-spin opacity-90' : 'opacity-0 group-hover:opacity-60'}`} />
    </button>
  );
}
