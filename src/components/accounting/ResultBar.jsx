/**
 * ResultBar — the thin "N resultados · Total RD$…" context line that sits right
 * above a filtered accounting list. It's the immediate feedback that a tab or
 * search actually changed something (the count/total move next to the control),
 * and a consistent piece of chrome across every list page.
 *
 * `count` + `singular`/`plural` build the left label; optional preformatted
 * `total` shows on the right; `note` appends extra context (e.g. a search term).
 */
export default function ResultBar({ count, singular, plural, total, note }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2 px-0.5 text-xs">
      <span className="text-ink-500">
        <span className="font-semibold text-ink-800 tabular-nums">{count}</span> {count === 1 ? singular : plural}
        {note}
      </span>
      {total != null && (
        <span className="text-ink-500 tabular-nums">Total <span className="font-semibold text-ink-900">{total}</span></span>
      )}
    </div>
  );
}
