import { useId } from 'react';

/**
 * Lean, dependency-free chart primitives for the accounting dashboard —
 * QuickBooks-style "Business overview" widgets. Pure presentational: they take
 * already-resolved numbers (the ViewModel does the math) and draw them with
 * inline SVG / CSS on the app's design tokens. Colors are passed in by the
 * caller so the incoming design system can re-skin them in one place.
 *
 * Three shapes cover the dashboard:
 *   • <Donut>     — ring with proportional segments + a center slot (gastos).
 *   • <BarPairs>  — grouped vertical bars, two per period (flujo de caja).
 *   • <AreaChart> — filled line over time (ventas).
 */

/** Ring chart. `segments: [{ value, color }]`; `children` fills the center. */
export function Donut({ segments = [], size = 132, thickness = 16, children }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value || 0), 0);
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const c = size / 2;
  let offset = 0;
  return (
    <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={c} cy={c} r={r} fill="none" strokeWidth={thickness} stroke="currentColor" className="text-ink-100" />
        {total > 0 && segments.map((s, i) => {
          const len = (Math.max(0, s.value || 0) / total) * circ;
          if (len <= 0.01) return null;
          // A hairline gap between segments (when there are several) keeps
          // slices legible instead of fusing into one ring.
          const gap = segments.length > 1 ? Math.min(2.5, len * 0.25) : 0;
          const dash = `${Math.max(0.5, len - gap)} ${circ - len + gap}`;
          const node = (
            <circle key={i} cx={c} cy={c} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={dash} strokeDashoffset={-offset} strokeLinecap={segments.length > 1 ? 'butt' : 'round'} />
          );
          offset += len;
          return node;
        })}
      </svg>
      {children != null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center leading-tight px-2">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Grouped vertical bars — two bars per period. `data: [{ label, a, b }]`;
 * `colors: [colorA, colorB]`. Scales to the tallest bar across the set.
 */
export function BarPairs({ data = [], colors = ['#059669', '#e8a76d'], height = 128, format }) {
  const max = Math.max(1, ...data.flatMap((d) => [Math.abs(d.a || 0), Math.abs(d.b || 0)]));
  return (
    <div className="min-w-0 w-full">
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex items-end justify-center gap-1 h-full">
            <Column h={Math.abs(d.a || 0) / max} color={colors[0]} title={format ? format(d.a || 0) : String(d.a)} />
            <Column h={Math.abs(d.b || 0) / max} color={colors[1]} title={format ? format(d.b || 0) : String(d.b)} />
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-1.5">
        {data.map((d, i) => (
          <div key={i} className="flex-1 text-center text-[10px] text-ink-400 uppercase tracking-wide truncate">{d.label}</div>
        ))}
      </div>
    </div>
  );
}

function Column({ h, color, title }) {
  return (
    <div
      className="w-2.5 sm:w-3 rounded-t-[4px]"
      style={{
        height: `${Math.max(2, h * 100)}%`,
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 72%, white), ${color} 88%)`,
        boxShadow: '0 1px 2px rgba(59,56,48,0.15)',
      }}
      title={title}
    />
  );
}

/** Filled line over time. `points: [{ label, value }]`. */
export function AreaChart({ points = [], color = '#059669', height = 116 }) {
  const id = useId();
  const W = 320; // SVG internal viewBox width — scales via width="100%"
  const H = 100;
  const pad = 8;
  const n = points.length;
  const max = Math.max(1, ...points.map((p) => p.value || 0));
  const xy = points.map((p, i) => {
    const x = n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad);
    const y = H - pad - ((p.value || 0) / max) * (H - 2 * pad);
    return [x, y];
  });
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = n > 0
    ? `${line} L${xy[n - 1][0].toFixed(1)} ${H} L${xy[0][0].toFixed(1)} ${H} Z`
    : '';
  return (
    <div className="min-w-0 w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" className="block">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && <path d={area} fill={`url(#${id})`} />}
        {n > 0 && (
          <path d={line} fill="none" stroke={color} strokeWidth="2"
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        )}
      </svg>
      <div className="flex mt-1.5">
        {points.map((p, i) => (
          <div key={i} className="flex-1 text-center text-[10px] text-ink-400 uppercase tracking-wide truncate">{p.label}</div>
        ))}
      </div>
    </div>
  );
}

/**
 * Sparkline — Tufte's word-sized graphic: a bare line (no axes, no grid) that
 * shows a metric's SHAPE next to its number. The endpoint dot anchors "now".
 * `points: number[]` (oldest first).
 */
export function Sparkline({ points = [], color = '#878374', height = 26, strokeWidth = 1.5 }) {
  const id = useId();
  const W = 120;
  const H = 32;
  const pad = 3;
  const n = points.length;
  if (n === 0) return null;
  const max = Math.max(...points, 0);
  const min = Math.min(...points, 0);
  const span = Math.max(1e-9, max - min);
  const xy = points.map((v, i) => [
    n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad),
    H - pad - (((v || 0) - min) / span) * (H - 2 * pad),
  ]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy[n - 1][0].toFixed(1)} ${H} L${xy[0][0].toFixed(1)} ${H} Z`;
  const [lx, ly] = xy[n - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" className="block" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.16" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.4" fill={color} />
    </svg>
  );
}

/**
 * Year-over-year columns — each period draws LAST year as a wide ghost column
 * with this year's solid column layered in front, sharing one scale, so the
 * eye reads gain/shortfall as overhang without a second chart. Hovering a
 * period shows both values + the delta. `data: [{ label, value, prev }]`.
 */
export function YoYColumns({ data = [], color = '#c96a2a', ghost = '#e3e1da', height = 150, format }) {
  const fmt = format || ((v) => String(v));
  const max = Math.max(1, ...data.flatMap((d) => [Math.abs(d.value || 0), Math.abs(d.prev || 0)]));
  const pctOf = (v) => `${Math.max(v > 0 ? 1.5 : 0, (Math.abs(v) / max) * 100)}%`;
  return (
    <div className="min-w-0 w-full">
      <div className="flex items-end gap-1.5 border-b border-ink-200" style={{ height }}>
        {data.map((d) => {
          const delta = d.prev > 0 ? Math.round(((d.value - d.prev) / d.prev) * 100) : null;
          const title = `${d.label}: ${fmt(d.value)} · año anterior ${fmt(d.prev)}${delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta}%` : ''}`;
          return (
            <div key={d.label} className="relative flex-1 h-full flex items-end justify-center" title={title}>
              <div className="absolute bottom-0 w-full max-w-7 rounded-t-[4px]"
                style={{ height: pctOf(d.prev), background: `linear-gradient(180deg, color-mix(in srgb, ${ghost} 55%, white), ${ghost})` }} />
              <div className="relative w-1/2 max-w-3.5 rounded-t-[4px]"
                style={{
                  height: pctOf(d.value),
                  background: `linear-gradient(180deg, color-mix(in srgb, ${color} 70%, white), ${color} 85%)`,
                  boxShadow: `inset 0 1px 0 color-mix(in srgb, ${color} 35%, white), 0 1px 2px rgba(59,56,48,0.18)`,
                }} />
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {data.map((d) => (
          <div key={d.label} className="flex-1 text-center text-[10px] text-ink-400 uppercase tracking-wide truncate">{d.label}</div>
        ))}
      </div>
    </div>
  );
}

/**
 * Bullet bar — a category's CURRENT value as a filled bar with the PREVIOUS
 * period as a thin marker tick on the same scale (Few's bullet graph): "where
 * is it now vs where it was" in one stripe. `max` is shared across the set.
 */
export function BulletBar({ value = 0, marker = null, max = 1, color = '#c96a2a', height = 10 }) {
  const pct = (v) => `${Math.min(100, (Math.max(0, v) / Math.max(1, max)) * 100)}%`;
  return (
    <div className="relative w-full rounded-full bg-ink-100 overflow-hidden"
      style={{ height, boxShadow: 'inset 0 1px 2px rgba(59,56,48,0.10)' }}>
      <div className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: pct(value),
          background: `linear-gradient(180deg, color-mix(in srgb, ${color} 68%, white), ${color})`,
          boxShadow: '0 1px 1.5px rgba(59,56,48,0.22)',
        }} />
      {marker != null && marker > 0 && (
        <div className="absolute inset-y-0 w-0.5 bg-ink-700/80 rounded-full" style={{ left: pct(marker) }} />
      )}
    </div>
  );
}

/** Inline legend — a dot + label per series. */
export function Legend({ items = [] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
      {items.map((it, i) => (
        <div key={i} className="inline-flex items-center gap-1.5 text-xs text-ink-500">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: it.color }} />
          {it.label}
        </div>
      ))}
    </div>
  );
}
