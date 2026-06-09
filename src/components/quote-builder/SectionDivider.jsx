import { useRef, useState, useEffect } from 'react';
import { Trash2, GripVertical, Hash } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';

/**
 * Section header row. Stored as a `quote_lines` row with `kind='section'`
 * and the label in the `name` field — keeps sort_order ordering working for
 * free, and the line can be deleted/dragged like any other row.
 *
 * Visually a low-weight divider so it doesn't compete with the items it
 * groups. Auto-focuses when first added (newly created sections need a
 * label immediately).
 */
export default function SectionDivider({ line, onChange, onRemove, autoFocus, dragHandleProps, subtotalLabel }) {
  const inputRef = useRef(null);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }, [autoFocus]);

  return (
    <li
      // Full-bleed (negative margin cancels the list's padding) so the section
      // band spans edge-to-edge and reads as a strong divider that brackets the
      // item cards beneath it — a clear level above an individual product.
      className="-mx-2.5 sm:-mx-3 px-4 sm:px-5 py-2.5 bg-brand-50/60 border-y border-brand-200/70 group"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-center gap-2">
        <span
          {...(dragHandleProps || {})}
          className={`cursor-grab text-ink-300 hover:text-ink-600 hidden sm:inline-flex transition-opacity ${hover || dragHandleProps?.['data-dragging'] === 'true' ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}
          title="Arrastra para reordenar"
        >
          <GripVertical size={14} />
        </span>
        <Hash size={12} className="text-brand-500 flex-shrink-0" />
        <DebouncedInput
          ref={inputRef}
          value={line.name || ''}
          onCommit={(v) => onChange({ name: v })}
          placeholder='Sección · p. ej. "Sala", "Habitación principal"'
          className="block flex-1 min-w-0 bg-transparent border-0 px-0 py-0 text-[12px] font-bold uppercase tracking-widest text-ink-600 placeholder:text-ink-400 placeholder:normal-case placeholder:font-medium placeholder:tracking-normal focus:outline-none"
        />
        {subtotalLabel && (
          <span className="text-[12px] font-semibold tabular-nums text-ink-500 whitespace-nowrap" title="Total de los artículos de esta sección">
            {subtotalLabel}
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          className={`inline-flex items-center justify-center w-7 h-7 coarse:w-11 coarse:h-11 text-ink-300 hover:text-red-500 rounded transition-all active:scale-[0.92] flex-shrink-0 ${hover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          aria-label="Eliminar sección"
          title="Eliminar sección"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </li>
  );
}
