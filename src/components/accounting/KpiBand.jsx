/**
 * Summary band — the row of headline figures above an accounting list/report.
 * `items`: [{ label, value, tone?: 'pos' | 'neg', hint? }]. `value` arrives
 * preformatted (the page owns formatDop/format choices); tone colors it.
 */
export default function KpiBand({ items }) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return null;
  const toneClass = (tone) =>
    tone === 'pos' ? 'text-emerald-700' : tone === 'neg' ? 'text-rose-700' : 'text-ink-900';
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      {list.map((it) => (
        <div key={it.label} className="card p-4 min-w-0">
          <div className="eyebrow mb-1">{it.label}</div>
          <div className={`text-lg sm:text-xl font-semibold tabular-nums whitespace-nowrap ${toneClass(it.tone)}`}>
            {it.value}
          </div>
          {it.hint && <div className="text-xs text-ink-400 mt-0.5">{it.hint}</div>}
        </div>
      ))}
    </div>
  );
}
