/**
 * Quiet loading indicator for list/table containers. Used while a page's
 * primary query is still in flight on first mount — keeps the chrome
 * visible (page header, search box, action button) but replaces the
 * "Sin X" empty state and the row content with a faint pulsing placeholder
 * so the user sees movement, not a misleading "you have no data" message.
 *
 * Once the query resolves we either render the real rows or the *true*
 * empty state. The dealer never sees "Sin cotizaciones" if there are
 * actually cotizaciones — that flicker was the bug.
 *
 * Rendered inside the same `.card` shell so the surrounding chrome
 * keeps its shape and the page doesn't reflow when data arrives.
 */
export default function ListLoading({ rows = 4, dense = false }) {
  const rowH = dense ? 'h-9' : 'h-14';
  return (
    <ul className="divide-y divide-ink-100/70 animate-pulse" aria-busy="true" aria-label="Cargando…">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className={`flex items-center gap-4 px-5 ${rowH}`}>
          {/* Vary widths so adjacent rows feel organic, not like a grid */}
          <span
            className="h-[7px] rounded-full bg-ink-100 flex-1"
            style={{ maxWidth: `${30 + ((i * 17) % 26)}%` }}
          />
          <span
            className="h-[7px] rounded-full bg-ink-100/80 flex-1"
            style={{ maxWidth: `${16 + ((i * 11) % 16)}%` }}
          />
          <span className="h-[7px] rounded-full bg-ink-100/60 w-12 shrink-0" />
        </li>
      ))}
    </ul>
  );
}
