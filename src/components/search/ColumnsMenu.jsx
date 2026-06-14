import { useRef, useState } from 'react';
import { Columns3, Eye, EyeOff, RotateCcw } from 'lucide-react';
import useDismissable from './useDismissable.js';

/**
 * Column visibility control — Shopify's "Columns" popover (the eye-toggle
 * list in the orders table's edit-columns panel). The parent owns which
 * columns exist and which are visible; this is a dumb picker that emits the
 * next visibility map.
 *
 * Same lightweight popover mechanics as SortMenu (relative wrapper + absolute
 * panel, dismiss via the shared useDismissable hook), so the two header menus
 * feel identical. Desktop-only by intent — it tunes a wide table, which the
 * mobile card layout doesn't have — so the call site wraps it in `hidden
 * md:block`.
 *
 * PROPS
 *   columns   Array<{ key, label, canHide?: boolean }> — same column list the
 *             table renders. A column with `canHide === false` (e.g. the
 *             identity/number column) is the fixed anchor and isn't listed.
 *   visible   { [key]: boolean } — current visibility for the hideable columns.
 *   onChange  (nextVisible) => void
 *   onReset   () => void — optional; restores the table's default columns.
 */
export default function ColumnsMenu({ columns, visible, onChange, onReset }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismissable(open, () => setOpen(false), ref);

  const hideable = (columns || []).filter((c) => c.canHide !== false);
  if (hideable.length === 0) return null;
  const shownCount = hideable.filter((c) => visible?.[c.key]).length;

  function toggle(key) {
    onChange({ ...visible, [key]: !visible?.[key] });
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-ghost border border-ink-200 bg-surface transition-colors hover:border-ink-300"
        title="Columnas"
      >
        <Columns3 size={14} />
        <span className="hidden lg:inline">Columnas</span>
        <span className="tabular-nums rounded-full bg-ink-100 px-1.5 text-[11px] font-semibold text-ink-500">
          {shownCount}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Columnas visibles"
          className="absolute right-0 z-30 mt-1 w-60 rounded-xl border border-ink-100 bg-surface py-1.5 shadow-pop"
        >
          <div className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            Columnas
          </div>
          {hideable.map((col) => {
            const on = !!visible?.[col.key];
            return (
              <button
                key={col.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggle(col.key)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-ink-50 active:bg-ink-100"
              >
                <span className={on ? 'font-medium text-ink-900' : 'text-ink-500'}>{col.label}</span>
                {on
                  ? <Eye size={15} className="text-brand-600" />
                  : <EyeOff size={15} className="text-ink-300" />}
              </button>
            );
          })}

          {onReset && (
            <div className="mt-1 border-t border-ink-100 px-2 pt-1.5">
              <button
                type="button"
                onClick={() => { onReset(); setOpen(false); }}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-ink-500 transition-colors hover:bg-ink-50 hover:text-ink-800"
              >
                <RotateCcw size={12} /> Restablecer
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
