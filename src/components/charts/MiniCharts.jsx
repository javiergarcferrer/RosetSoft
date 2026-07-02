import { useEffect, useId, useRef, useState } from 'react';

/**
 * Lean, dependency-free chart primitives for the accounting dashboard —
 * QuickBooks-style "Business overview" widgets. Pure presentational: they take
 * already-resolved numbers (the ViewModel does the math) and draw them with
 * inline SVG / CSS on the app's design tokens. Colors are passed in by the
 * caller so the incoming design system can re-skin them in one place.
 *
 * The shapes that cover the dashboard:
 *   • <Donut>      — ring with proportional segments + a center slot (gastos).
 *   • <BarPairs>   — grouped vertical bars, two per period (legacy; kept for
 *                    callers that don't need the hover/grid layer).
 *   • <ComboChart> — grouped or stacked bars + an overlaid line on ONE shared
 *                    scale (flujo de caja: entradas/salidas + neto), with
 *                    gridlines, hover tooltips and an endpoint direct label.
 *   • <AreaChart>  — filled line over time (ventas), optional hover + endpoint.
 *   • <Sparkline>  — Tufte word-sized trend on a KPI card.
 *   • <YoYColumns> — this year solid over last year's ghost.
 *   • <BulletBar>  — Few bullet: current value + a previous-period marker tick.
 *   • <Waterfall>  — the P&L bridge, with per-step value labels + % of income.
 *   • <AgingBars>  — receivables by age bucket on one shared scale.
 *   • <CountUp>    — an animated, reduced-motion-aware number (KPI heroes).
 *
 * Shared plumbing: `useChartTip`/<ChartTip> (a pointer-tracked tooltip layer —
 * it ENHANCES, never gates: every tooltip value is also on the chart, its
 * legend list or its table twin), `niceTicks` (clean y-axis gridline values)
 * and `compactNumber` (axis/direct labels: 1.2M / 850K). Gridlines are solid
 * hairlines one step off the surface; motion honors prefers-reduced-motion.
 */

/* ────────────────────────── shared plumbing ────────────────────────── */

/** 1234567 → "1.2M", 85300 → "85K", 1500 → "1.5K", 930 → "930". */
export function compactNumber(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const trim = (x, d) => x.toFixed(d).replace(/\.0$/, '');
  if (a >= 1e6) return `${sign}${trim(a / 1e6, 1)}M`;
  if (a >= 1e5) return `${sign}${trim(a / 1e3, 0)}K`;
  if (a >= 1e3) return `${sign}${trim(a / 1e3, 1)}K`;
  return `${sign}${trim(a, 0)}`;
}

/** Clean gridline values for a 0-based scale: multiples of 1/2/2.5/5×10ⁿ. */
export function niceTicks(max, target = 3) {
  if (!(max > 0)) return [];
  const rough = max / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) || 10 * pow;
  const out = [];
  for (let v = step; v <= max * 1.001; v += step) out.push(v);
  return out;
}

/**
 * Pointer-tracked tooltip state for a chart plot. Attach `ref` to the RELATIVE
 * plot container, call `show(evt, { title, rows })` from a mark/hit-area's
 * onPointerMove and `hide` from the container's onPointerLeave, and render
 * `<ChartTip tip={tip} />` inside the container.
 */
function useChartTip() {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const show = (e, payload) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, ...payload });
  };
  const hide = () => setTip(null);
  return { ref, tip, show, hide };
}

/** The tooltip card: title (category), then value-led rows keyed by a short
 *  stroke of the series color (values lead, labels follow). */
function ChartTip({ tip }) {
  if (!tip) return null;
  const flip = tip.x > tip.w * 0.6;
  return (
    <div
      className="absolute z-20 pointer-events-none"
      style={{
        left: tip.x,
        top: Math.max(2, tip.y - 8),
        transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -100%)`,
      }}
    >
      <div className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 shadow-lg whitespace-nowrap">
        {tip.title != null && (
          <div className="text-[10px] uppercase tracking-wide text-ink-400 leading-tight mb-0.5">{tip.title}</div>
        )}
        {(tip.rows || []).map((r, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs leading-5">
            {r.color && <span className="w-2.5 h-0.5 rounded-full shrink-0" style={{ background: r.color }} />}
            {r.k != null && <span className="text-ink-500">{r.k}</span>}
            <span className="ml-auto pl-3 font-semibold tabular-nums text-ink-900">{r.v}</span>
            {r.note != null && <span className="pl-1 text-[10px] text-ink-400 tabular-nums">{r.note}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal hairline gridlines + compact reference labels for a 0-based
 *  scale mapped by `yPct(value) → bottom offset %`. Solid, recessive. */
function GridLines({ ticks, yPct }) {
  return ticks.map((t) => (
    <div key={t} className="absolute inset-x-0 border-t border-ink-100 pointer-events-none" style={{ bottom: `${yPct(t)}%` }}>
      <span className="absolute left-0 bottom-px text-[9px] leading-none tabular-nums text-ink-400 select-none">
        {compactNumber(t)}
      </span>
    </div>
  ));
}

/* ─────────────────────────────── donut ─────────────────────────────── */

/**
 * Ring chart. `segments: [{ value, color, label? }]`; `children` fills the
 * center. When segments carry a `label`, hovering a slice shows a tooltip
 * with its exact value (`format`) and share; the caller's legend list stays
 * the always-visible identity channel.
 */
export function Donut({ segments = [], size = 132, thickness = 16, children, format, ariaLabel }) {
  const { ref, tip, show, hide } = useChartTip();
  const total = segments.reduce((s, x) => s + Math.max(0, x.value || 0), 0);
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const c = size / 2;
  const fmt = format || ((v) => String(v));
  let offset = 0;
  return (
    <div
      ref={ref}
      className="relative inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
      onPointerLeave={hide}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={c} cy={c} r={r} fill="none" strokeWidth={thickness} stroke="currentColor" className="text-ink-100" />
        {total > 0 && segments.map((s, i) => {
          const len = (Math.max(0, s.value || 0) / total) * circ;
          if (len <= 0.01) return null;
          // A hairline gap between segments (when there are several) keeps
          // slices legible instead of fusing into one ring.
          const gap = segments.length > 1 ? Math.min(2.5, len * 0.25) : 0;
          const dash = `${Math.max(0.5, len - gap)} ${circ - len + gap}`;
          const share = Math.round(((s.value || 0) / total) * 100);
          const node = (
            <circle
              key={i} cx={c} cy={c} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={dash} strokeDashoffset={-offset} strokeLinecap={segments.length > 1 ? 'butt' : 'round'}
              onPointerMove={s.label != null ? (e) => show(e, {
                title: s.label,
                rows: [{ v: fmt(s.value || 0), note: `${share}%`, color: s.color }],
              }) : undefined}
            />
          );
          offset += len;
          return node;
        })}
      </svg>
      {children != null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center leading-tight px-2 pointer-events-none">
          {children}
        </div>
      )}
      <ChartTip tip={tip} />
    </div>
  );
}

/* ─────────────────────────── grouped bars ──────────────────────────── */

/**
 * Grouped vertical bars — two bars per period. `data: [{ label, a, b }]`;
 * `colors: [colorA, colorB]`. Scales to the tallest bar across the set.
 * Legacy shape (title-attr values only) — prefer <ComboChart> for new
 * surfaces; it adds gridlines, tooltips and the overlay line.
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
      className="w-2.5 sm:w-3 rounded-t-[4px] motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-out"
      style={{
        height: `${Math.max(2, h * 100)}%`,
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 72%, rgb(var(--surface))), ${color} 88%)`,
        boxShadow: '0 1px 2px rgba(59,56,48,0.15)',
      }}
      title={title}
    />
  );
}

/* ─────────────────────────── combo chart ───────────────────────────── */

/**
 * Bars + an overlaid line on ONE shared value scale (never a second axis).
 * `data: [{ label, a, b?, line? }]` — `a`/`b` draw as grouped columns (or one
 * stacked column with a 2px surface gap when `stacked`), `line` as a 2px line
 * with surface-ringed endpoint dot + compact direct label. Gridlines are
 * clean-number hairlines; hovering a period shows every series' exact value
 * (`format`). The line may go negative (net cash) — the zero baseline anchors.
 */
export function ComboChart({
  data = [],
  colors = ['#059669', '#c76b29'],
  seriesLabels = ['A', 'B'],
  lineColor = 'rgb(var(--ink-700))',
  lineLabel = 'Neto',
  stacked = false,
  height = 150,
  format,
  gridlines = true,
  lastLabel = true,
  ariaLabel,
}) {
  const { ref, tip, show, hide } = useChartTip();
  const fmt = format || ((v) => String(v));
  const n = data.length;
  const hasB = data.some((d) => d.b != null);
  const hasLine = data.some((d) => d.line != null);
  const barTop = (d) => (stacked
    ? Math.max(0, d.a || 0) + Math.max(0, d.b || 0)
    : Math.max(Math.abs(d.a || 0), Math.abs(d.b || 0)));
  const max = Math.max(1, ...data.map(barTop), ...(hasLine ? data.map((d) => d.line || 0) : [0]));
  const min = Math.min(0, ...(hasLine ? data.map((d) => d.line || 0) : [0]));
  const span = max - min || 1;
  const yPct = (v) => ((v - min) / span) * 100; // bottom offset, %
  const zero = yPct(0);
  const ticks = gridlines ? niceTicks(max) : [];
  const last = n > 0 ? data[n - 1] : null;

  const tipFor = (d) => ({
    title: d.label,
    rows: [
      { k: seriesLabels[0], v: fmt(d.a || 0), color: colors[0] },
      hasB && { k: seriesLabels[1], v: fmt(d.b || 0), color: colors[1] },
      hasLine && { k: lineLabel, v: fmt(d.line || 0), color: lineColor },
    ].filter(Boolean),
  });

  return (
    <div className="min-w-0 w-full" role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      <div ref={ref} className="relative" style={{ height }} onPointerLeave={hide}>
        <GridLines ticks={ticks} yPct={yPct} />
        {/* zero baseline (reads when the line dips negative) */}
        <div className="absolute inset-x-0 border-t border-ink-200 pointer-events-none" style={{ bottom: `${zero}%` }} />

        {/* per-period hit columns + bars */}
        <div className="absolute inset-0 flex">
          {data.map((d, i) => (
            <div
              key={i}
              className="relative flex-1 min-w-0 rounded-t-md hover:bg-ink-500/[0.05] transition-colors"
              onPointerMove={(e) => show(e, tipFor(d))}
            >
              {/* the region above the zero line — bar heights scale to it */}
              <div
                className="absolute inset-x-0 flex items-end justify-center gap-0.5"
                style={{ bottom: `${zero}%`, height: `${100 - zero}%` }}
              >
                {stacked ? (
                  <div className="w-2.5 sm:w-3 h-full flex flex-col-reverse justify-start gap-[2px]">
                    <div className="rounded-t-[4px] shrink-0 motion-safe:transition-all motion-safe:duration-500"
                      style={{ height: `${(Math.max(0, d.a || 0) / max) * 100}%`, background: colors[0] }} />
                    {hasB && (
                      <div className="rounded-t-[4px] shrink-0 motion-safe:transition-all motion-safe:duration-500"
                        style={{ height: `${(Math.max(0, d.b || 0) / max) * 100}%`, background: colors[1] }} />
                    )}
                  </div>
                ) : (
                  <>
                    <Column h={Math.abs(d.a || 0) / max} color={colors[0]} />
                    {hasB && <Column h={Math.abs(d.b || 0) / max} color={colors[1]} />}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* overlay line + endpoint dot (2px, surface-ringed) */}
        {hasLine && n > 1 && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <path
              d={data.map((d, i) => `${i ? 'L' : 'M'}${(((i + 0.5) / n) * 100).toFixed(2)} ${(100 - yPct(d.line || 0)).toFixed(2)}`).join(' ')}
              fill="none" stroke={lineColor} strokeWidth="2" vectorEffect="non-scaling-stroke"
              strokeLinejoin="round" strokeLinecap="round"
            />
          </svg>
        )}
        {hasLine && last && (
          <div
            className="absolute w-2 h-2 rounded-full pointer-events-none"
            style={{
              left: `${((n - 0.5) / n) * 100}%`, bottom: `${yPct(last.line || 0)}%`,
              transform: 'translate(-50%, 50%)', background: lineColor,
              boxShadow: '0 0 0 2px rgb(var(--surface))',
            }}
          />
        )}
        {hasLine && last && lastLabel && (
          <div
            className="absolute text-[10px] font-semibold tabular-nums text-ink-700 bg-surface/85 rounded px-1 leading-tight pointer-events-none"
            style={{ left: `${((n - 0.5) / n) * 100}%`, bottom: `calc(${yPct(last.line || 0)}% + 7px)`, transform: 'translateX(-100%)' }}
          >
            {compactNumber(last.line || 0)}
          </div>
        )}
        <ChartTip tip={tip} />
      </div>
      <div className="flex mt-1.5">
        {data.map((d, i) => (
          <div key={i} className="flex-1 text-center text-[10px] text-ink-400 uppercase tracking-wide truncate">{d.label}</div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── area chart ────────────────────────────── */

/**
 * Filled line over time. `points: [{ label, value }]`. With `format`, a hover
 * crosshair snaps to the nearest month and shows its exact value; `showLast`
 * direct-labels the endpoint (surface-ringed dot + compact value).
 */
export function AreaChart({ points = [], color = '#059669', height = 116, format, showLast = false, gridlines = false, ariaLabel }) {
  const id = useId();
  const { ref, tip, show, hide } = useChartTip();
  const [hoverI, setHoverI] = useState(null);
  const W = 320; // SVG internal viewBox width — scales via width="100%"
  const H = 100;
  const pad = 8;
  const n = points.length;
  const max = Math.max(1, ...points.map((p) => p.value || 0));
  const fx = (i) => (n <= 1 ? 0.5 : pad / W + (i / (n - 1)) * (1 - (2 * pad) / W)); // 0..1 across width
  const fy = (v) => 1 - (pad / H + ((v || 0) / max) * (1 - (2 * pad) / H));         // 0..1 from top
  const xy = points.map((p, i) => [fx(i) * W, fy(p.value) * H]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = n > 0
    ? `${line} L${xy[n - 1][0].toFixed(1)} ${H} L${xy[0][0].toFixed(1)} ${H} Z`
    : '';
  const fmt = format || ((v) => String(v));
  const ticks = gridlines ? niceTicks(max) : [];

  const onMove = (e) => {
    if (!format || n === 0) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = (e.clientX - r.left) / Math.max(1, r.width);
    const i = Math.max(0, Math.min(n - 1, Math.round(((frac - pad / W) / (1 - (2 * pad) / W)) * (n - 1))));
    setHoverI(i);
    show(e, { title: points[i].label, rows: [{ v: fmt(points[i].value || 0), color }] });
  };
  const onLeave = () => { setHoverI(null); hide(); };

  return (
    <div className="min-w-0 w-full" role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      <div ref={ref} className="relative" style={{ height }} onPointerMove={onMove} onPointerLeave={onLeave}>
        <GridLines ticks={ticks} yPct={(v) => (v / max) * (1 - (2 * pad) / H) * 100 + (pad / H) * 100} />
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none" className="block absolute inset-0">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.14" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {area && <path d={area} fill={`url(#${id})`} />}
          {n > 0 && (
            <path d={line} fill="none" stroke={color} strokeWidth="2"
              vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          )}
        </svg>
        {/* crosshair + snapped dot */}
        {hoverI != null && (
          <>
            <div className="absolute inset-y-0 border-l border-ink-200 pointer-events-none" style={{ left: `${fx(hoverI) * 100}%` }} />
            <div className="absolute w-2 h-2 rounded-full pointer-events-none"
              style={{
                left: `${fx(hoverI) * 100}%`, top: `${fy(points[hoverI].value) * 100}%`,
                transform: 'translate(-50%, -50%)', background: color,
                boxShadow: '0 0 0 2px rgb(var(--surface))',
              }} />
          </>
        )}
        {showLast && n > 0 && (
          <>
            <div className="absolute w-2 h-2 rounded-full pointer-events-none"
              style={{
                left: `${fx(n - 1) * 100}%`, top: `${fy(points[n - 1].value) * 100}%`,
                transform: 'translate(-50%, -50%)', background: color,
                boxShadow: '0 0 0 2px rgb(var(--surface))',
              }} />
            <div className="absolute text-[10px] font-semibold tabular-nums text-ink-700 bg-surface/85 rounded px-1 leading-tight pointer-events-none"
              style={{ left: `${fx(n - 1) * 100}%`, top: `calc(${fy(points[n - 1].value) * 100}% - 8px)`, transform: 'translate(-100%, -100%)' }}>
              {compactNumber(points[n - 1].value || 0)}
            </div>
          </>
        )}
        <ChartTip tip={tip} />
      </div>
      <div className="flex mt-1.5">
        {points.map((p, i) => (
          <div key={i} className="flex-1 text-center text-[10px] text-ink-400 uppercase tracking-wide truncate">{p.label}</div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── sparkline ─────────────────────────────── */

/**
 * Sparkline — Tufte's word-sized graphic: a bare line (no axes, no grid) that
 * shows a metric's SHAPE next to its number. The endpoint dot anchors "now".
 * `points: number[]` (oldest first).
 */
export function Sparkline({ points = [], color = 'rgb(var(--ink-400))', height = 26, strokeWidth = 1.5 }) {
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

/* ────────────────────────── YoY columns ────────────────────────────── */

/**
 * Year-over-year columns — each period draws LAST year as a wide ghost column
 * with this year's solid column layered in front, sharing one scale, so the
 * eye reads gain/shortfall as overhang without a second chart. Hovering a
 * period shows both exact values + the delta in a tooltip; `gridlines` adds
 * clean-number hairlines and `lastLabel` direct-labels the newest column.
 * `data: [{ label, value, prev }]`.
 */
export function YoYColumns({
  data = [], color = '#c96a2a', ghost = 'rgb(var(--ink-100))', height = 150, format,
  gridlines = false, lastLabel = false, ariaLabel,
}) {
  const { ref, tip, show, hide } = useChartTip();
  const fmt = format || ((v) => String(v));
  const max = Math.max(1, ...data.flatMap((d) => [Math.abs(d.value || 0), Math.abs(d.prev || 0)]));
  const pctOf = (v) => `${Math.max(v > 0 ? 1.5 : 0, (Math.abs(v) / max) * 100)}%`;
  const ticks = gridlines ? niceTicks(max) : [];
  return (
    <div className="min-w-0 w-full" role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      <div ref={ref} className="relative border-b border-ink-200" style={{ height }} onPointerLeave={hide}>
        <GridLines ticks={ticks} yPct={(v) => (v / max) * 100} />
        <div className="absolute inset-0 flex items-end gap-1.5">
          {data.map((d, i) => {
            const delta = d.prev > 0 ? Math.round(((d.value - d.prev) / d.prev) * 100) : null;
            return (
              <div
                key={d.label}
                className="relative flex-1 h-full flex items-end justify-center rounded-t-md hover:bg-ink-500/[0.05] transition-colors"
                onPointerMove={(e) => show(e, {
                  title: d.label,
                  rows: [
                    { k: 'Este año', v: fmt(d.value || 0), color },
                    { k: 'Año anterior', v: fmt(d.prev || 0), color: ghost },
                    delta != null && { k: 'Δ', v: `${delta >= 0 ? '+' : ''}${delta}%` },
                  ].filter(Boolean),
                })}
              >
                <div className="absolute bottom-0 w-full max-w-7 rounded-t-[4px]"
                  style={{ height: pctOf(d.prev), background: `linear-gradient(180deg, color-mix(in srgb, ${ghost} 55%, rgb(var(--surface))), ${ghost})` }} />
                <div className="relative w-1/2 max-w-3.5 rounded-t-[4px] motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-out"
                  style={{
                    height: pctOf(d.value),
                    background: `linear-gradient(180deg, color-mix(in srgb, ${color} 70%, rgb(var(--surface))), ${color} 85%)`,
                    boxShadow: `inset 0 1px 0 color-mix(in srgb, ${color} 35%, rgb(var(--surface))), 0 1px 2px rgba(59,56,48,0.18)`,
                  }} />
                {lastLabel && i === data.length - 1 && (
                  <div className="absolute text-[9px] font-semibold tabular-nums text-ink-700 bg-surface/85 rounded px-1 leading-tight pointer-events-none"
                    style={{ bottom: `calc(${pctOf(d.value)} + 3px)`, left: '50%', transform: 'translateX(-50%)' }}>
                    {compactNumber(d.value || 0)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <ChartTip tip={tip} />
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {data.map((d) => (
          <div key={d.label} className="flex-1 text-center text-[10px] text-ink-400 uppercase tracking-wide truncate">{d.label}</div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── bullet bar ────────────────────────────── */

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
      <div className="absolute inset-y-0 left-0 rounded-full motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-out"
        style={{
          width: pct(value),
          background: `linear-gradient(180deg, color-mix(in srgb, ${color} 68%, rgb(var(--surface))), ${color})`,
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

/* ─────────────────────────── waterfall ─────────────────────────────── */

/**
 * Waterfall (cascada) — the P&L bridge. `steps: [{ label, value, total? }]`:
 * a `total` step is drawn from the zero baseline (Ingresos opens, Utilidad
 * closes); the rest FLOAT by their signed `value` off the running cumulative,
 * so the eye walks revenue down through costs and gastos to the bottom line.
 * Rises read emerald, drops rose, totals ink; a hairline connects the steps
 * and a zero baseline anchors the scale (handles a negative utilidad).
 * `labels` writes each step's compact value on its cap; `showPct` adds every
 * step's share of the FIRST total (ingresos) to the label + tooltip. Bars
 * ease to their new size on a period switch (motion-safe only).
 */
export function Waterfall({ steps = [], height = 132, colors = {}, format, labels = true, showPct = false, ariaLabel }) {
  const { ref, tip, show, hide } = useChartTip();
  const inc = colors.increase || '#059669';
  const dec = colors.decrease || '#fb7185';
  const tot = colors.total || 'rgb(var(--ink-400))';
  const fmt = format || ((v) => String(v));

  // Running cumulative → each bar's [lo, hi] on the value axis + its end level.
  let run = 0;
  const segs = steps.map((s) => {
    const v = Number(s.value) || 0;
    let lo, hi, end;
    if (s.total) { lo = Math.min(0, v); hi = Math.max(0, v); end = v; }
    else { const next = run + v; lo = Math.min(run, next); hi = Math.max(run, next); end = next; }
    const seg = { label: s.label, value: v, total: !!s.total, lo, hi, end, run };
    run = s.total ? v : end;
    return seg;
  });

  const min = Math.min(0, ...segs.map((s) => s.lo));
  const max = Math.max(0, ...segs.map((s) => s.hi));
  const span = Math.max(1, max - min);
  const yPct = (val) => ((max - val) / span) * 100; // top offset, %
  const base = segs.find((s) => s.total)?.value || 0; // % base = the opening total
  const pctOfBase = (v) => (base > 0 ? Math.round((Math.abs(v) / base) * 100) : null);
  const labelPad = labels ? 15 : 0; // headroom so cap labels never clip

  return (
    <div className="min-w-0 w-full" role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      <div ref={ref} className="relative" style={{ height: height + labelPad }} onPointerLeave={hide}>
        <div className="absolute inset-x-0 bottom-0" style={{ top: labelPad }}>
          {/* zero baseline */}
          <div className="absolute inset-x-0 border-t border-dashed border-ink-200" style={{ top: `${yPct(0)}%` }} />
          {segs.map((s, i) => {
            const top = yPct(s.hi);
            const h = ((s.hi - s.lo) / span) * 100;
            const color = s.total ? tot : (s.value >= 0 ? inc : dec);
            const sign = s.value > 0 && !s.total ? '+' : '';
            const pct = pctOfBase(s.value);
            return (
              <div
                key={s.label}
                className="absolute inset-y-0 min-w-0 hover:bg-ink-500/[0.05] rounded-md transition-colors"
                style={{ left: `${(i / segs.length) * 100}%`, width: `${100 / segs.length}%` }}
                onPointerMove={(e) => show(e, {
                  title: s.label,
                  rows: [{
                    v: `${sign}${fmt(s.value)}`, color,
                    note: showPct && pct != null && !(s.total && i === 0) ? `${pct}% de ingresos` : undefined,
                  }],
                })}
              >
                {/* connector from the previous step's end level, spanning the
                    whole gap between the two bars' edges */}
                {i > 0 && (
                  <div className="absolute h-px bg-ink-300/70 pointer-events-none"
                    style={{ top: `${yPct(segs[i - 1].end)}%`, left: 'calc(-16% - 0.375rem)', width: 'calc(32% + 0.375rem)' }} />
                )}
                <div
                  className="absolute inset-x-0 mx-auto w-[68%] max-w-8 rounded-[3px] motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-out"
                  style={{
                    top: `${top}%`,
                    height: `${Math.max(1.5, h)}%`,
                    background: `linear-gradient(180deg, color-mix(in srgb, ${color} 70%, rgb(var(--surface))), ${color} 88%)`,
                    boxShadow: `inset 0 1px 0 color-mix(in srgb, ${color} 35%, rgb(var(--surface))), 0 1px 2px rgba(59,56,48,0.18)`,
                  }}
                />
                {labels && (
                  <div className="absolute inset-x-0 text-center pointer-events-none" style={{ top: `calc(${top}% - 13px)` }}>
                    <span className="text-[9px] font-semibold tabular-nums text-ink-600 bg-surface/85 rounded px-0.5 leading-tight">
                      {sign}{compactNumber(s.value)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <ChartTip tip={tip} />
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {segs.map((s) => (
          <div key={s.label} className="flex-1 text-center text-[10px] text-ink-400 uppercase tracking-wide truncate">{s.label}</div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── aging bars ────────────────────────────── */

/**
 * Aging bars — receivables by age bucket on ONE shared scale (small multiples),
 * so the overdue tail reads at a glance against the current column. `buckets:
 * [{ label, value, tone }]`; the row label and amount flank the bar. The bar
 * eases to its new width on a period switch (motion-safe only).
 */
export function AgingBars({ buckets = [], format }) {
  const fmt = format || ((v) => String(v));
  const max = Math.max(1, ...buckets.map((b) => Math.abs(b.value || 0)));
  return (
    <div className="space-y-1.5">
      {buckets.map((b) => {
        const v = Math.abs(b.value || 0);
        return (
          <div key={b.label} className="flex items-center gap-2 text-xs min-w-0" title={`${b.label} días: ${fmt(b.value || 0)}`}>
            <span className="w-11 shrink-0 text-ink-400 tabular-nums">{b.label}</span>
            <div className="flex-1 h-2.5 rounded-full bg-ink-100 overflow-hidden min-w-0" style={{ boxShadow: 'inset 0 1px 2px rgba(59,56,48,0.10)' }}>
              <div className="h-full rounded-full motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-out"
                style={{
                  width: `${v > 0 ? Math.max(3, (v / max) * 100) : 0}%`,
                  background: `linear-gradient(180deg, color-mix(in srgb, ${b.tone} 70%, rgb(var(--surface))), ${b.tone})`,
                }} />
            </div>
            <span className="w-20 shrink-0 text-right tabular-nums text-ink-600">{fmt(b.value || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * CountUp — an animated number for the KPI heroes. It eases (cubic ease-out)
 * from the currently shown value to the new one, then hands the result to
 * `format`; on mount it rises from zero, so a freshly loaded panel or a period
 * switch feels alive. It animates ONLY on a value change (the `value` dep), not
 * on every background re-render, and honors prefers-reduced-motion (it snaps
 * straight to the value). `format` receives the in-flight float each frame.
 */
export function CountUp({ value = 0, format = (n) => String(Math.round(n)), duration = 650, className = '' }) {
  const [display, setDisplay] = useState(0);
  const displayRef = useRef(0);
  displayRef.current = display;
  const rafRef = useRef(0);

  useEffect(() => {
    const to = Number(value) || 0;
    const from = Number(displayRef.current) || 0;
    if (prefersReducedMotion() || from === to) { setDisplay(to); return undefined; }
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(from + (to - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else setDisplay(to);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return <span className={className}>{format(display)}</span>;
}
