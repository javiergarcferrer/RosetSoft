/**
 * The accounting pages' in-page tab strip (list/606, diario/mayor/balanza, …) —
 * one shared pill row instead of a per-page button group.
 * `tabs`: [{ key, label }] · `active`: current key · `onChange(key)`.
 *
 * Rendered as a tight segmented control: each tab is a bordered chip so it
 * reads as tappable at rest, fills solid when active, and presses on tap. The
 * row scrolls horizontally on a phone (no reflow) so it stays one clean strip.
 */
export default function TabPills({ tabs, active, onChange }) {
  return (
    <div className="flex flex-nowrap gap-1.5 mb-3 overflow-x-auto -mx-1 px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {(tabs || []).map((t) => {
        const on = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(t.key)}
            className={`shrink-0 rounded-md px-3 py-1.5 min-h-9 coarse:min-h-10 text-sm font-medium whitespace-nowrap transition-[background-color,color,border-color,transform] duration-150 active:scale-[0.97] select-none border ${
              on
                ? 'bg-ink-900 text-ink-50 border-ink-900 shadow-sm'
                : 'bg-surface text-ink-600 border-ink-200 hover:bg-ink-50 hover:text-ink-900 hover:border-ink-300 active:bg-ink-100'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
