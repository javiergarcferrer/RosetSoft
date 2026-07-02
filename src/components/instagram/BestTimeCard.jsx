// Best-time-to-post heatmap. Desktop renders the full 7×24 (weekday × hour);
// a phone can't fit 24 columns at a usable size, so below md it folds into the
// VM's 7×6 four-hour buckets — reduce density rather than scroll sideways.
// Accessibility is deliberate: rows run Monday-first (the local convention),
// an explicit menos→más legend explains the opacity ramp, and every cell is
// inspectable without a mouse — tap/click or arrow-key a cell and its exact
// figures print in a caption under the grid (tooltips enhance, never gate).
import { useMemo, useState } from 'react';
import { Clock } from 'lucide-react';
import { fmt } from './chrome.jsx';

// Sequential single-hue ramp: brand at opacity ∝ engagement; zero = ink track.
const heatBg = (norm) => (norm > 0 ? `rgb(var(--brand-500) / ${(0.15 + norm * 0.85).toFixed(2)})` : 'rgb(var(--ink-100))');

// Display order: Monday-first (the VM keeps cells keyed 0 = Sunday).
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

function cellText(dayLabel, timeLabel, count, engagement) {
  return count > 0
    ? `${dayLabel} ${timeLabel} · ${count} ${count === 1 ? 'publicación' : 'publicaciones'} · ${fmt(engagement)} interacciones`
    : `${dayLabel} ${timeLabel} · sin publicaciones`;
}

function Heatmap({ bestTimes, sel, setSel }) {
  const cellByKey = useMemo(() => {
    const m = new Map();
    for (const c of bestTimes.cells) m.set(`${c.day}:${c.hour}`, c);
    return m;
  }, [bestTimes]);
  const bucketByKey = useMemo(() => {
    const m = new Map();
    for (const b of bestTimes.buckets) m.set(`${b.day}:${b.bucket}`, b);
    return m;
  }, [bestTimes]);

  // Roving keyboard selection over the desktop grid — the container is the
  // single tab stop (168 individually tabbable cells would be pure noise).
  const onKeyDown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') { setSel(null); return; }
    const cur = sel?.kind === 'hour' ? sel : {
      kind: 'hour',
      day: bestTimes.peak?.day ?? DAY_ORDER[0],
      i: bestTimes.peak?.hour ?? 12,
    };
    let { day, i } = cur;
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    if (e.key === 'ArrowRight') i = Math.min(23, i + 1);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const at = DAY_ORDER.indexOf(day);
      day = DAY_ORDER[e.key === 'ArrowUp' ? Math.max(0, at - 1) : Math.min(6, at + 1)];
    }
    setSel({ kind: 'hour', day, i });
  };

  return (
    <>
      {/* desktop — 7×24, Monday-first */}
      <div
        className="hidden md:block space-y-[3px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        tabIndex={0}
        role="group"
        aria-label={`Mapa de calor de interacciones por día y hora.${bestTimes.peak ? ` Mejor ventana: ${bestTimes.peak.label}.` : ''} Usa las flechas para recorrer las celdas.`}
        onKeyDown={onKeyDown}
      >
        {DAY_ORDER.map((day) => {
          const label = bestTimes.dayLabels[day];
          return (
            <div key={day} className="flex items-center gap-1.5">
              <div className="w-8 shrink-0 text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
              <div className="flex gap-[2px] flex-1">
                {Array.from({ length: 24 }, (_, hour) => {
                  const c = cellByKey.get(`${day}:${hour}`);
                  const isPeak = bestTimes.peak && bestTimes.peak.day === day && bestTimes.peak.hour === hour;
                  const isSel = sel?.kind === 'hour' && sel.day === day && sel.i === hour;
                  const text = cellText(label, hourLabel(hour), c?.count || 0, c?.engagement || 0);
                  return (
                    <button
                      key={hour}
                      type="button"
                      tabIndex={-1}
                      onClick={() => setSel(isSel ? null : { kind: 'hour', day, i: hour })}
                      className={`h-4 flex-1 rounded-[2px] ${isSel ? 'ring-2 ring-ink-700' : isPeak ? 'ring-2 ring-brand-600' : ''}`}
                      style={{ backgroundColor: heatBg(c?.norm || 0) }}
                      title={text}
                      aria-label={text}
                      aria-pressed={isSel}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="flex items-center gap-1.5 pl-9 text-[10px] text-ink-400" aria-hidden>
          <span>0h</span><span className="flex-1 text-center">6h</span><span className="flex-1 text-center">12h</span><span className="flex-1 text-center">18h</span><span>23h</span>
        </div>
      </div>

      {/* mobile — 7×6 four-hour buckets, Monday-first; buttons make the
          figures tappable (title tooltips don't exist on touch) */}
      <div className="md:hidden space-y-1">
        {DAY_ORDER.map((day) => {
          const label = bestTimes.dayLabels[day];
          return (
            <div key={day} className="flex items-center gap-1.5">
              <div className="w-8 shrink-0 text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
              <div className="flex gap-1 flex-1">
                {Array.from({ length: 6 }, (_, bucket) => {
                  const b = bucketByKey.get(`${day}:${bucket}`);
                  const isSel = sel?.kind === 'bucket' && sel.day === day && sel.i === bucket;
                  const text = cellText(label, `${bestTimes.bucketLabels[bucket]} h`, b?.count || 0, b?.engagement || 0);
                  return (
                    <button
                      key={bucket}
                      type="button"
                      onClick={() => setSel(isSel ? null : { kind: 'bucket', day, i: bucket })}
                      className={`h-6 flex-1 rounded-[3px] ${isSel ? 'ring-2 ring-ink-700' : ''}`}
                      style={{ backgroundColor: heatBg(b?.norm || 0) }}
                      aria-label={text}
                      aria-pressed={isSel}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="flex gap-1 pl-9 text-[9px] text-ink-400" aria-hidden>
          {bestTimes.bucketLabels.map((l) => <span key={l} className="flex-1 text-center">{l}</span>)}
        </div>
      </div>
    </>
  );
}

export default function BestTimeCard({ bestTimes }) {
  const [sel, setSel] = useState(null);

  // The tapped/keyed cell's exact figures — the tooltip's always-visible twin.
  const caption = useMemo(() => {
    if (!sel) return null;
    const dl = bestTimes.dayLabels[sel.day];
    if (sel.kind === 'hour') {
      const c = bestTimes.cells.find((x) => x.day === sel.day && x.hour === sel.i);
      return cellText(dl, hourLabel(sel.i), c?.count || 0, c?.engagement || 0);
    }
    const b = bestTimes.buckets.find((x) => x.day === sel.day && x.bucket === sel.i);
    return cellText(dl, `${bestTimes.bucketLabels[sel.i]} h`, b?.count || 0, b?.engagement || 0);
  }, [sel, bestTimes]);

  return (
    <div className="card">
      <div className="card-header">
        <span className="flex items-center gap-2 font-medium"><Clock size={15} /> Mejor hora para publicar</span>
      </div>
      <div className="card-pad">
        {!bestTimes.hasData ? (
          <div className="text-sm text-ink-400">Publica algunas veces y aquí verás cuándo tu audiencia responde mejor.</div>
        ) : (
          <>
            <Heatmap bestTimes={bestTimes} sel={sel} setSel={setSel} />

            {/* legend — the opacity ramp, spelled out */}
            <div className="mt-2.5 flex items-center gap-1.5 text-[10px] text-ink-400" aria-hidden>
              <span>Menos</span>
              {[0, 0.25, 0.5, 0.75, 1].map((n) => (
                <span key={n} className="h-2.5 w-4 rounded-[2px]" style={{ backgroundColor: heatBg(n) }} />
              ))}
              <span>Más</span>
              <span className="ml-2">interacciones · hora local</span>
            </div>

            <div aria-live="polite">
              {caption && (
                <div className="mt-2 rounded-lg bg-ink-50 px-3 py-1.5 text-xs text-ink-600 tabular-nums">{caption}</div>
              )}
            </div>

            {bestTimes.peak && (
              <div className="mt-3 text-sm text-ink-600">
                Tu mejor ventana histórica: <span className="font-medium text-ink-900">{bestTimes.peak.label}</span>{' '}
                <span className="text-ink-400">— programa el próximo post ahí y compara.</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
