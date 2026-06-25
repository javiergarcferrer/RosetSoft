/**
 * Summary band — the row of headline figures above an accounting list/report.
 * `items`: [{ label, value, tone?: 'pos' | 'neg', hint? }]. `value` arrives
 * preformatted (the page owns formatDop/format choices); tone colors it.
 *
 * Rendered as ONE flat panel of stat lines, not a row of floating cards: on a
 * phone each figure is a label→value line divided by hairlines; on sm+ it
 * fans into a 2/4-column strip. The `gap-px bg-ink-100` grid draws the
 * hairlines between cells in any column count (no per-cell border math).
 */
export default function KpiBand({ items }) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return null;
  const toneClass = (tone) =>
    tone === 'pos' ? 'text-emerald-700' : tone === 'neg' ? 'text-rose-700' : 'text-ink-900';
  return (
    <div className="card overflow-hidden mb-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-ink-100">
        {list.map((it) => (
          <div
            key={it.label}
            className="bg-surface px-3.5 py-2.5 flex items-baseline justify-between gap-3 sm:flex-col sm:items-start sm:gap-0.5 min-w-0"
          >
            <div className="eyebrow-xs shrink-0">{it.label}</div>
            <div className="min-w-0 text-right sm:text-left">
              <div className={`font-display text-base sm:text-lg font-semibold tabular-nums whitespace-nowrap ${toneClass(it.tone)}`}>
                {it.value}
              </div>
              {it.hint && <div className="text-[11px] text-ink-400 leading-tight">{it.hint}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
