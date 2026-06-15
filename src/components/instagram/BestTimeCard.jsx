// Best-time-to-post heatmap. Desktop renders the full 7×24 (weekday × hour);
// a phone can't fit 24 columns at a usable size, so below md it folds into the
// VM's 7×6 four-hour buckets — reduce density rather than scroll sideways.
import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import { fmt } from './chrome.jsx';

const heatBg = (norm) => (norm > 0 ? `rgb(var(--brand-500) / ${(0.15 + norm * 0.85).toFixed(2)})` : 'rgb(var(--ink-100))');

function Heatmap({ bestTimes }) {
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
  return (
    <>
      {/* desktop — 7×24 */}
      <div className="hidden md:block space-y-[3px]">
        {bestTimes.dayLabels.map((label, day) => (
          <div key={day} className="flex items-center gap-1.5">
            <div className="w-8 shrink-0 text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
            <div className="flex gap-[2px] flex-1">
              {Array.from({ length: 24 }, (_, hour) => {
                const c = cellByKey.get(`${day}:${hour}`);
                const norm = c?.norm || 0;
                const isPeak = bestTimes.peak && bestTimes.peak.day === day && bestTimes.peak.hour === hour;
                return (
                  <div
                    key={hour}
                    className={`h-4 flex-1 rounded-[2px] ${isPeak ? 'ring-2 ring-brand-600' : ''}`}
                    style={{ backgroundColor: heatBg(norm) }}
                    title={c && c.count ? `${label} ${String(hour).padStart(2, '0')}:00 · ${c.count} post${c.count > 1 ? 's' : ''} · ${fmt(c.engagement)} interacciones` : `${label} ${String(hour).padStart(2, '0')}:00`}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-1.5 pl-9 text-[10px] text-ink-400">
          <span>0h</span><span className="flex-1 text-center">6h</span><span className="flex-1 text-center">12h</span><span className="flex-1 text-center">18h</span><span>23h</span>
        </div>
      </div>
      {/* mobile — 7×6 four-hour buckets */}
      <div className="md:hidden space-y-1">
        {bestTimes.dayLabels.map((label, day) => (
          <div key={day} className="flex items-center gap-1.5">
            <div className="w-8 shrink-0 text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
            <div className="flex gap-1 flex-1">
              {Array.from({ length: 6 }, (_, bucket) => {
                const b = bucketByKey.get(`${day}:${bucket}`);
                const norm = b?.norm || 0;
                return (
                  <div
                    key={bucket}
                    className="h-6 flex-1 rounded-[3px]"
                    style={{ backgroundColor: heatBg(norm) }}
                    title={b && b.count ? `${label} ${bestTimes.bucketLabels[bucket]}h · ${fmt(b.engagement)} interacciones` : `${label} ${bestTimes.bucketLabels[bucket]}h`}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex gap-1 pl-9 text-[9px] text-ink-400">
          {bestTimes.bucketLabels.map((l) => <span key={l} className="flex-1 text-center">{l}</span>)}
        </div>
      </div>
    </>
  );
}

export default function BestTimeCard({ bestTimes }) {
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
            <Heatmap bestTimes={bestTimes} />
            {bestTimes.peak && (
              <div className="mt-3 text-sm text-ink-600">
                Tu mejor ventana histórica: <span className="font-medium text-ink-900">{bestTimes.peak.label}</span>{' '}
                <span className="text-ink-400">(por interacciones, hora local).</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
