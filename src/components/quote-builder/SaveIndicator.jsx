import { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { relativeFromNow } from '../../lib/relativeTime.js';

/**
 * Subtle "Guardado hace 2s" badge near the title — tells the dealer that
 * autosave is real and recent, without ever needing a save button.
 *
 * Re-renders every 10s while idle so the relative-time stamp stays fresh
 * without a visible tick.
 */
export default function SaveIndicator({ savedAt, saving }) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (saving || !savedAt) return;
    const id = setInterval(() => setT((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, [savedAt, saving]);

  if (saving) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-ink-500">
        <RefreshCw size={11} className="animate-spin" /> Guardando…
      </span>
    );
  }
  if (!savedAt) {
    return <span className="inline-flex items-center gap-1 text-[11px] text-ink-400">Sin cambios</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-ink-500">
      <Check size={11} className="text-emerald-600" /> Guardado {relativeFromNow(savedAt)}
    </span>
  );
}
