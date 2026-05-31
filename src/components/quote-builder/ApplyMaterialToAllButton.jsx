import { Copy } from 'lucide-react';

// "Apply this fabric to every component" — the quiet icon twin of
// MaterialPickerButton, rendered directly beneath it. Icon-only on purpose: a
// compound with several components drowned under a repeated text button, so the
// glyph carries the action and the explanation rides in on HOVER via a soft
// tooltip (not the OS `title` chrome). Callers gate visibility — it shows only
// while copying this piece's material would actually change a sibling.
export default function ApplyMaterialToAllButton({
  onClick,
  label = 'Aplicar esta tela a todos los componentes',
  className = '',
}) {
  return (
    <span className={`group/applyall relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="inline-flex items-center justify-center w-7 h-7 coarse:w-9 coarse:h-9 rounded-md text-ink-400 hover:text-brand-700 hover:bg-brand-50 transition-colors flex-shrink-0"
      >
        <Copy size={14} />
      </button>
      {/* Soft tooltip — opens to the RIGHT, where every surface has open space,
          so a tight icon stack never sits on top of it. Pointer devices only;
          the aria-label carries the same meaning for touch + screen readers. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 -translate-y-1/2 w-max max-w-[220px] rounded-md bg-ink-900 px-2.5 py-1.5 text-[11px] font-medium leading-snug text-white shadow-soft opacity-0 transition-opacity duration-150 group-hover/applyall:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
