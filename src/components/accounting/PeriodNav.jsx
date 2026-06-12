import { ChevronLeft, ChevronRight } from 'lucide-react';
import { resolvePeriod, stepPeriodRef } from '../../core/accounting/index.js';

const KINDS = [
  { key: 'month', label: 'Mes' },
  { key: 'quarter', label: 'Trimestre' },
  { key: 'year', label: 'Año' },
];

/**
 * The panel's period navigator — kind pills (Mes/Trimestre/Año) + ‹ › steppers
 * around the resolved period label. Controlled: `{ kind, ref }` +
 * `onChange({ kind, ref })`; the page derives the actual window with
 * `resolvePeriod({ kind, ref })`.
 */
export default function PeriodNav({ kind, refMs, onChange }) {
  const period = resolvePeriod({ kind, ref: refMs });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1">
        {KINDS.map((k) => (
          <button key={k.key} type="button"
            onClick={() => onChange({ kind: k.key, ref: refMs })}
            className={`btn ${kind === k.key ? 'tab-pill-active' : 'tab-pill'}`}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="inline-flex items-center gap-1">
        <button type="button" aria-label="Período anterior"
          onClick={() => onChange({ kind, ref: stepPeriodRef(kind, refMs, -1) })}
          className="btn-ghost px-2"><ChevronLeft size={15} /></button>
        <span className="text-sm font-medium text-ink-800 min-w-28 text-center capitalize">{period.label}</span>
        <button type="button" aria-label="Período siguiente"
          onClick={() => onChange({ kind, ref: stepPeriodRef(kind, refMs, 1) })}
          className="btn-ghost px-2"><ChevronRight size={15} /></button>
      </div>
    </div>
  );
}

/** Delta chip — green up / red down vs a comparison window. */
export function DeltaChip({ delta, vs }) {
  if (delta == null) return <span className="text-xs text-ink-300">—</span>;
  const up = delta >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${up ? 'text-emerald-700' : 'text-rose-600'}`}
      title={vs ? `vs ${vs}` : undefined}>
      {up ? '▲' : '▼'} {Math.abs(Math.round(delta * 100))}%
    </span>
  );
}
