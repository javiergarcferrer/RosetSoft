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
export default function SectionDivider({ line, onChange, onRemove, autoFocus, dragHandleProps }) {
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
      className="px-3 sm:px-4 py-2 bg-ink-50/60 border-y border-ink-100 group"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-center gap-2">
        <span
          {...(dragHandleProps || {})}
          className={`cursor-grab text-ink-300 hover:text-ink-700 hidden sm:inline-flex ${hover || dragHandleProps?.['data-dragging'] === 'true' ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}
          title="Arrastra para reordenar"
        >
          <GripVertical size={14} />
        </span>
        <Hash size={12} className="text-brand-600 flex-shrink-0" />
        <DebouncedInput
          ref={inputRef}
          value={line.name || ''}
          onCommit={(v) => onChange({ name: v })}
          placeholder='Sección · p. ej. "Sala", "Habitación principal"'
          className="block flex-1 bg-transparent border-0 px-0 py-0 text-[13px] font-semibold uppercase tracking-wide text-ink-700 placeholder:text-ink-400 placeholder:normal-case placeholder:font-medium focus:outline-none"
        />
        <button
          type="button"
          onClick={onRemove}
          className={`text-ink-400 hover:text-red-600 p-1 ${hover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
          aria-label="Eliminar sección"
          title="Eliminar sección"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </li>
  );
}
