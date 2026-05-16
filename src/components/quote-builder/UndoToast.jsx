import { useCallback, useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';

/**
 * Inline undo toast — the answer to "did I just delete the wrong thing?".
 *
 * Returns:
 *   - a render element to drop into the layout (renders nothing when idle)
 *   - a `show(message, undoFn)` function to flash a toast
 *
 * Tied into the parent's lifetime via the returned element; the toast lives
 * for ~6s, dismissable on undo or X.
 */
export function useUndoToast() {
  const [state, setState] = useState(null); // { message, undo }
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setState(null);
  }, []);

  const show = useCallback((message, undoFn) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setState({ message, undo: undoFn });
    timerRef.current = setTimeout(() => setState(null), 6_000);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const element = state ? (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-40 bottom-24 md:bottom-6 bg-ink-900 text-ink-50 rounded-lg shadow-pop px-4 py-2.5 flex items-center gap-3 text-sm"
      role="status"
    >
      <span className="min-w-0">{state.message}</span>
      <button
        type="button"
        onClick={async () => {
          try { await state.undo(); } finally { dismiss(); }
        }}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-xs font-medium"
      >
        <Undo2 size={12} /> Deshacer
      </button>
    </div>
  ) : null;

  return { show, element };
}
