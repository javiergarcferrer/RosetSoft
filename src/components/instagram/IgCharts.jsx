// IgCharts — the Instagram command center's chart primitives. Pure
// presentational: every number arrives already derived by a ViewModel
// (core/jarvis); these only draw. Built on the design tokens (ink/brand CSS
// vars) so every mark is correct in light AND dark without a per-chart sweep,
// and on the dataviz ground rules: zero-baselined bars, one hue + a neutral
// (never a rainbow), direct labels over legends, tooltips that enhance but
// never gate (every value is also visible or in a caption), reduced-motion
// safe (no decorative animation), and keyboard access on the scrubbed chart.
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { fmt, fmtCompact } from './chrome.jsx';

/**
 * Honest delta chip. `value` is the signed change (percent by default); null
 * renders nothing — a missing comparison base is never dressed up as 0.
 * Color = direction × whether up is good (`goodIsUp:null` → neutral ink, for
 * measures like spend where more isn't inherently better or worse).
 */
export function DeltaChip({ value, format = (v) => `${Math.round(Math.abs(v))}%`, goodIsUp = true, title }) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  const up = v > 0;
  const flat = v === 0;
  const good = flat || goodIsUp == null ? null : up === goodIsUp;
  const cls = good === true
    ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
    : good === false
      ? 'bg-rose-600/10 text-rose-700 dark:text-rose-400'
      : 'bg-ink-100 text-ink-600';
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${cls}`}
      title={title}
      aria-label={`${flat ? 'sin cambio' : up ? 'sube' : 'baja'} ${format(v)}${title ? ` ${title}` : ''}`}
    >
      {!flat && <Icon size={11} className="shrink-0" aria-hidden />}
      {flat ? '=' : format(v)}
    </span>
  );
}

/**
 * Area trend — the reach chart. Gradient wash under a 2px line (both
 * currentColor: set a token text class on the parent and it theme-flips for
 * free), zero baseline, an average hairline, the max point direct-labeled, and
 * a scrub layer: pointer (mouse/touch, `touch-action:pan-y` so vertical page
 * scroll survives) or ←/→ keys snap a crosshair to the nearest day and show
 * date + value. The tooltip never gates: a stats caption (prom/máx/mín) keeps
 * every headline figure readable without hovering.
 * `data: [{ ms, label, value }]` oldest first; `stats` from the VM.
 */
export function AreaTrend({ data = [], stats = null, height = 128, formatValue = fmtCompact, ariaLabel = 'Tendencia' }) {
  const n = data.length;
  const boxRef = useRef(null);
  const gradId = useId();
  const [idx, setIdx] = useState(null);

  const max = Math.max(1, stats?.max ?? Math.max(0, ...data.map((d) => d.value)));
  const xPct = useCallback((i) => (n <= 1 ? 50 : (i / (n - 1)) * 100), [n]);
  const yPct = (v) => 100 - (Math.max(0, v) / max) * 100;

  const paths = useMemo(() => {
    if (n === 0) return { line: '', area: '' };
    const pts = data.map((d, i) => [xPct(i), yPct(d.value)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    const area = `${line} L${pts[n - 1][0].toFixed(2)} 100 L${pts[0][0].toFixed(2)} 100 Z`;
    return { line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, n, max]);

  const clampIdx = (i) => Math.max(0, Math.min(n - 1, i));
  const onPointerMove = (e) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || n === 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    setIdx(clampIdx(Math.round(frac * (n - 1))));
  };
  const onKeyDown = (e) => {
    if (n === 0) return;
    if (e.key === 'ArrowLeft') { setIdx((i) => clampIdx((i ?? n - 1) - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setIdx((i) => clampIdx((i ?? n - 2) + 1)); e.preventDefault(); }
    else if (e.key === 'Home') { setIdx(0); e.preventDefault(); }
    else if (e.key === 'End') { setIdx(n - 1); e.preventDefault(); }
    else if (e.key === 'Escape') setIdx(null);
  };

  if (n < 2) return null;
  const cur = idx != null ? data[idx] : null;
  const maxAt = stats ? data[stats.maxIndex] : null;
  const summary = stats
    ? `${ariaLabel}. Promedio ${formatValue(stats.avg)}, máximo ${formatValue(stats.max)}${maxAt?.label ? ` el ${maxAt.label}` : ''}, mínimo ${formatValue(stats.min)}.`
    : ariaLabel;

  return (
    <div>
      <div
        ref={boxRef}
        role="img"
        aria-label={summary}
        tabIndex={0}
        className="relative w-full cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded-sm [touch-action:pan-y]"
        style={{ height }}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerMove}
        onPointerLeave={() => setIdx(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setIdx(null)}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={paths.area} fill={`url(#${gradId})`} />
          <path d={paths.line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </svg>

        {/* average reference — a recessive solid hairline, labeled directly */}
        {stats && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-ink-200" style={{ top: `${yPct(stats.avg)}%` }} aria-hidden>
            <span className="absolute right-0 -top-3.5 text-[9px] uppercase tracking-wide text-ink-400">prom. {formatValue(stats.avg)}</span>
          </div>
        )}

        {/* max point — direct label (hidden while scrubbing so labels never collide) */}
        {stats && idx == null && (
          <div className="pointer-events-none absolute" style={{ left: `${xPct(stats.maxIndex)}%`, top: `${yPct(stats.max)}%` }} aria-hidden>
            <span className="absolute -translate-x-1/2 -translate-y-1/2 block h-2 w-2 rounded-full bg-current ring-2 ring-surface" />
            <span className={`absolute bottom-2 whitespace-nowrap text-[10px] font-medium tabular-nums text-ink-700 ${stats.maxIndex > n * 0.8 ? 'right-1' : stats.maxIndex < n * 0.2 ? 'left-1' : '-translate-x-1/2'}`}>
              máx {formatValue(stats.max)}
            </span>
          </div>
        )}

        {/* scrub crosshair + dot + tooltip */}
        {cur && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-ink-300" style={{ left: `${xPct(idx)}%` }} aria-hidden />
            <span
              className="pointer-events-none absolute block h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-surface"
              style={{ left: `${xPct(idx)}%`, top: `${yPct(cur.value)}%` }}
              aria-hidden
            />
            <div
              className={`pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-ink-200 bg-surface px-2 py-1 shadow-sm ${idx < n * 0.15 ? '' : idx > n * 0.85 ? '-translate-x-full' : '-translate-x-1/2'}`}
              style={{ left: `${xPct(idx)}%`, top: `${Math.max(0, yPct(cur.value) - 26)}%` }}
            >
              <span className="font-display text-sm font-semibold tabular-nums text-ink-900">{fmt(cur.value)}</span>
              <span className="ml-1.5 text-[10px] text-ink-500">{cur.label}</span>
            </div>
          </>
        )}
      </div>

      {/* x-axis — first / middle / last dates, recessive */}
      <div className="mt-1 flex justify-between text-[10px] text-ink-400" aria-hidden>
        <span>{data[0].label}</span>
        <span>{data[Math.floor((n - 1) / 2)].label}</span>
        <span>{data[n - 1].label}</span>
      </div>

      {/* stats caption — the tooltip's no-hover twin */}
      {stats && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-ink-500 tabular-nums">
          <span>prom. <b className="font-medium text-ink-700">{formatValue(stats.avg)}</b>/día</span>
          <span>máx <b className="font-medium text-ink-700">{formatValue(stats.max)}</b>{maxAt?.label ? ` (${maxAt.label})` : ''}</span>
          <span>mín <b className="font-medium text-ink-700">{formatValue(stats.min)}</b></span>
        </div>
      )}
    </div>
  );
}

/**
 * Part-to-whole split bar — 2–3 parts on one stripe with 2px surface gaps
 * (the spacer separates, never a border) and a direct-labeled legend (label +
 * % + count), so identity never rides on color alone.
 * `parts: [{ label, value, barClass }]` — barClass is a token bg class.
 */
export function SplitBar({ parts = [], format = fmt }) {
  const shown = parts.filter((p) => (p.value || 0) > 0);
  const total = shown.reduce((s, p) => s + p.value, 0);
  if (total <= 0 || shown.length === 0) return null;
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={shown.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
        {shown.map((p) => (
          <div key={p.label} className={`${p.barClass} first:rounded-l-full last:rounded-r-full`} style={{ width: `${(p.value / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
        {shown.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${p.barClass}`} aria-hidden />
            {p.label} <b className="font-medium tabular-nums text-ink-700">{Math.round((p.value / total) * 100)}%</b>
            <span className="tabular-nums text-ink-400">({format(p.value)})</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Zero-baselined columns — one series (no legend; the card title names it).
 * Thin bars (≤24px), 4px rounded caps, every value direct-labeled on its cap
 * (the honest option at ≤8 columns, so the tooltip never gates).
 * `data: [{ label, value }]`.
 */
export function Columns({ data = [], barClass = 'bg-brand-500', height = 96, format = fmtCompact, ariaLabel }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value || 0)));
  return (
    <div role="img" aria-label={ariaLabel ? `${ariaLabel}: ${data.map((d) => `${d.label} ${format(d.value || 0)}`).join(', ')}` : undefined}>
      <div className="flex items-end gap-2 border-b border-ink-100" style={{ height }}>
        {data.map((d, i) => {
          const v = Math.abs(d.value || 0);
          return (
            <div key={`${d.label}-${i}`} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${d.label}: ${fmt(d.value || 0)}`}>
              <span className="mb-0.5 text-[10px] tabular-nums text-ink-500">{format(d.value || 0)}</span>
              <div
                className={`w-full max-w-6 rounded-t-[4px] ${v > 0 ? barClass : 'bg-ink-100'}`}
                style={{ height: v > 0 ? `${Math.max(2, (v / max) * 100)}%` : '2px' }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-2">
        {data.map((d, i) => (
          <div key={`${d.label}-${i}`} className="min-w-0 flex-1 truncate text-center text-[10px] text-ink-400">{d.label}</div>
        ))}
      </div>
    </div>
  );
}

/**
 * Paired columns — two series per period sharing ONE zero-baselined scale,
 * with a legend (two series → legend required) and per-pair tooltips.
 * `data: [{ label, a, b }]`, `series: [{ label, barClass }, { label, barClass }]`.
 */
export function PairedColumns({ data = [], series = [], height = 96, format = fmtCompact, ariaLabel }) {
  const max = Math.max(1, ...data.flatMap((d) => [Math.abs(d.a || 0), Math.abs(d.b || 0)]));
  const [sa, sb] = series;
  return (
    <div>
      <div
        className="flex items-end gap-2 border-b border-ink-100"
        style={{ height }}
        role="img"
        aria-label={ariaLabel ? `${ariaLabel}: ${data.map((d) => `${d.label} ${sa?.label} ${format(d.a || 0)}, ${sb?.label} ${format(d.b || 0)}`).join('; ')}` : undefined}
      >
        {data.map((d, i) => (
          <div
            key={`${d.label}-${i}`}
            className="flex h-full min-w-0 flex-1 items-end justify-center gap-[2px]"
            title={`${d.label} · ${sa?.label} ${fmt(d.a || 0)} · ${sb?.label} ${fmt(d.b || 0)}`}
          >
            <div className={`w-2.5 rounded-t-[4px] ${(d.a || 0) > 0 ? sa?.barClass : 'bg-ink-100'}`} style={{ height: (d.a || 0) > 0 ? `${Math.max(2, (Math.abs(d.a) / max) * 100)}%` : '2px' }} />
            <div className={`w-2.5 rounded-t-[4px] ${(d.b || 0) > 0 ? sb?.barClass : 'bg-ink-100'}`} style={{ height: (d.b || 0) > 0 ? `${Math.max(2, (Math.abs(d.b) / max) * 100)}%` : '2px' }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2">
        {data.map((d, i) => (
          <div key={`${d.label}-${i}`} className="min-w-0 flex-1 truncate text-center text-[10px] text-ink-400">{d.label}</div>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-[2px] ${s.barClass}`} aria-hidden /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Ordinal single-hue ramp for funnel stages (light → dark = top → bottom).
const FUNNEL_RAMP = ['bg-brand-200', 'bg-brand-400', 'bg-brand-600'];

/**
 * Funnel stages — impresiones → clics → resultados. Bars are proportional to
 * the FIRST stage (honest lengths; a 1% click bar IS nearly invisible — the
 * direct value label carries it), stages wear an ordinal one-hue ramp, and the
 * conversion between steps is written out (`convLabel convPct`) instead of
 * being left to eyeball. `stages: [{ label, value, convPct?, convLabel? }]`.
 */
export function FunnelStages({ stages = [], format = fmtCompact }) {
  const base = Math.max(1, stages[0]?.value || 0);
  const pct1 = (v) => (v == null ? '—' : `${Number(v).toLocaleString('es-DO', { maximumFractionDigits: v < 10 ? 2 : 1 })}%`);
  return (
    <div className="space-y-1" role="img" aria-label={`Embudo: ${stages.map((s) => `${s.label} ${fmt(s.value || 0)}`).join(', ')}`}>
      {stages.map((s, i) => (
        <div key={s.label}>
          {i > 0 && (
            <div className="pl-[5.5rem] text-[10px] text-ink-400 tabular-nums">
              ↳ {s.convLabel || 'conversión'} {pct1(s.convPct)}
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="w-20 shrink-0 truncate text-xs text-ink-500" title={s.label}>{s.label}</div>
            <div className="h-3 min-w-0 flex-1">
              <div
                className={`h-full rounded-full ${FUNNEL_RAMP[Math.min(i, FUNNEL_RAMP.length - 1)]}`}
                style={{ width: `${Math.max(1, ((s.value || 0) / base) * 100)}%` }}
              />
            </div>
            <div className="w-14 shrink-0 text-right text-xs font-medium tabular-nums text-ink-800">{format(s.value || 0)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Leaderboard magnitude bar — a thin comparative stripe under a list row
 * (top posts, formats). Length carries the value; the row's own text carries
 * the exact number, so no tooltip needed.
 */
export function ScaleBar({ value = 0, max = 1, barClass = 'bg-brand-400', className = '' }) {
  const w = Math.max(0, Math.min(100, (Math.max(0, value) / Math.max(1, max)) * 100));
  return (
    <div className={`h-1 w-full overflow-hidden rounded-full bg-ink-100 ${className}`} aria-hidden>
      <div className={`h-full rounded-full ${barClass}`} style={{ width: `${w}%` }} />
    </div>
  );
}
