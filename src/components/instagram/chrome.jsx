// Shared chrome for the Instagram pane (the Marketing + Studio tabs live under
// one shell, src/pages/Instagram.jsx). These primitives used to be copy-pasted
// in both pages; keeping them here is the single source so the two surfaces
// can't drift — same KPI tile, same freshness clock, same live-status pill.
import { createContext, useContext, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';

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

// A KPI tile — the analytics layer's material figure. Shared by both tabs.
export function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat-card p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className={`font-display text-2xl font-semibold tabular-nums mt-0.5 ${tone || 'text-ink-900'}`}>{value}</div>
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

// The active tab publishes its live-fetch status up to the shell, which renders
// the single LivePill (and owns the per-second freshness ticker) in the unified
// header. Keeping ONE pill in the header — instead of one per page — is why the
// two tabs share a consistent "live" signal and the seconds tick without
// re-rendering the active tab's whole subtree.
const LiveCtx = createContext(() => {});
export const InstagramLiveProvider = LiveCtx.Provider;

export function useInstagramLive({ loading, hasData, error, loadedAt, onRefresh }) {
  const publish = useContext(LiveCtx);
  useEffect(() => {
    publish({ loading, hasData, error, loadedAt, onRefresh });
    return () => publish(null);
  }, [publish, loading, hasData, error, loadedAt, onRefresh]);
}
