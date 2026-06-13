import { useRef, useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, Check } from 'lucide-react';
import useDismissable from './useDismissable.js';

/**
 * Sort control — Shopify's "Sort" button + dropdown. The parent owns the
 * sort state as `{ key, dir }` and does the actual sorting; this is a dumb
 * picker that emits the next `{ key, dir }`.
 *
 * Interaction model copied from the Shopify admin: tapping a sort key that
 * is NOT current selects it (keeping the current direction); tapping the
 * key that IS current flips its direction. So one menu serves both "sort by
 * what" and "which way" without a separate asc/desc toggle cluttering the
 * header. Each row shows its current arrow so the direction is legible.
 *
 * Lives in a relative wrapper with an absolutely-positioned panel — same
 * lightweight approach as ProfileMenu, no portal needed because the header
 * isn't inside an `overflow:hidden` / `transform` ancestor. Esc and
 * outside-click close it via the shared useDismissable hook; ArrowUp/Down +
 * Enter are handled natively because each option is a real <button>.
 */
export default function SortMenu({ sortOptions, sort, onSortChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismissable(open, () => setOpen(false), ref);

  if (!sortOptions || sortOptions.length === 0) return null;

  const current = sortOptions.find((o) => o.key === sort?.key) || sortOptions[0];
  const dir = sort?.dir || 'desc';

  function pick(key) {
    if (key === current.key) {
      onSortChange({ key, dir: dir === 'asc' ? 'desc' : 'asc' });
    } else {
      onSortChange({ key, dir });
    }
    // Keep the menu open on a direction-flip would be fiddly to reason
    // about; closing on every pick matches the native <select> mental model.
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-ghost border border-ink-200 bg-surface transition-colors hover:border-ink-300"
        title="Ordenar"
      >
        <ArrowUpDown size={14} />
        <span className="hidden sm:inline">{current.label}</span>
        {dir === 'asc' ? <ArrowUp size={13} className="text-ink-400" /> : <ArrowDown size={13} className="text-ink-400" />}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Ordenar por"
          className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-ink-100 bg-surface py-1.5 shadow-pop"
        >
          {sortOptions.map((o) => {
            const isCurrent = o.key === current.key;
            return (
              <button
                key={o.key}
                type="button"
                role="menuitem"
                onClick={() => pick(o.key)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition-colors active:scale-[0.99] ${
                  isCurrent
                    ? 'bg-brand-50 font-medium text-brand-700 hover:bg-brand-100'
                    : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900 active:bg-ink-100'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  {isCurrent ? (
                    <Check size={14} className="text-brand-600" />
                  ) : (
                    <span className="w-3.5" aria-hidden />
                  )}
                  {o.label}
                </span>
                {isCurrent && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-brand-400">
                    {dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                    {dir === 'asc' ? 'Asc.' : 'Desc.'}
                  </span>
                )}
              </button>
            );
          })}

          {/* Explicit direction control — tap-the-current-key-to-flip still
              works, but this makes the direction discoverable instead of a
              hidden gesture. */}
          <div className="mt-1.5 border-t border-ink-100 px-2 pt-1.5 grid grid-cols-2 gap-1" role="group" aria-label="Dirección">
            <button
              type="button"
              aria-pressed={dir === 'asc'}
              onClick={() => { onSortChange({ key: current.key, dir: 'asc' }); setOpen(false); }}
              className={`inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                dir === 'asc' ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200' : 'text-ink-500 hover:bg-ink-50 hover:text-ink-800'
              }`}
            >
              <ArrowUp size={12} /> Ascendente
            </button>
            <button
              type="button"
              aria-pressed={dir === 'desc'}
              onClick={() => { onSortChange({ key: current.key, dir: 'desc' }); setOpen(false); }}
              className={`inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                dir === 'desc' ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200' : 'text-ink-500 hover:bg-ink-50 hover:text-ink-800'
              }`}
            >
              <ArrowDown size={12} /> Descendente
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
