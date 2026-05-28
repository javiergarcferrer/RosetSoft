import { forwardRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { DebouncedInput } from '../DebouncedInput.js';

export interface InlineEditorProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'ref'> {
  label?: ReactNode;
  value: string | number | null | undefined;
  onCommit: (value: string) => void;
  placeholder?: string;
  /**
   * Tailwind width utility for the input. Treated as a *min-width* —
   * the input auto-grows past it via `field-sizing: content` so long
   * values (long fabric names, full dimensions like "H 28 × L 89 × P 43")
   * expand the field instead of getting visually clipped. The widthClass
   * sets the baseline reading length and the min-size when empty.
   */
  widthClass?: string;
  /** mono = render values in the monospaced UI font (refs, codes, dims). */
  mono?: boolean;
  className?: string;
}

/**
 * Inline label:value editor. Reads as flat text until the user hovers or
 * focuses, when a thin baseline appears under the value. On touch devices
 * (no hover) the baseline is permanent so editability is discoverable.
 *
 * Use inside compact "meta strips" — reference numbers, page pointers,
 * dimensions, dates — where surfacing a full <input className="input"> for
 * every field would crush the layout. For form-style fields with labels
 * above the input, use a standard labeled `<input className="input">`.
 */
const InlineEditor = forwardRef<HTMLInputElement, InlineEditorProps>(function InlineEditor({
  label,
  value,
  onCommit,
  placeholder,
  // Tailwind width utility for the input. Treated as a *min-width* —
  // the input auto-grows past it via `field-sizing: content` so long
  // values (long fabric names, full dimensions like "H 28 × L 89 × P 43")
  // expand the field instead of getting visually clipped. The widthClass
  // sets the baseline reading length and the min-size when empty.
  widthClass = 'w-24',
  // mono = render values in the monospaced UI font (refs, codes, dims).
  mono = false,
  className = '',
  ...inputProps
}, ref) {
  return (
    // inline-flex + min-w-0 + flex-wrap on the parent strip lets the
    // whole label:value unit shift onto a new row when the row runs
    // out of horizontal space.
    <label className="inline-flex items-baseline gap-1.5 max-w-full min-w-0">
      {label != null && label !== '' && (
        <span className="eyebrow-xs tracking-wide text-ink-400 select-none flex-shrink-0">
          {label}
        </span>
      )}
      <DebouncedInput
        ref={ref}
        value={value}
        onCommit={onCommit}
        placeholder={placeholder}
        className={`qli-grow ${widthClass} bg-transparent border-0 border-b border-transparent coarse:border-ink-100 hover:border-ink-200 focus:!border-ink-900 px-0 py-1 coarse:min-h-10 text-[13px] coarse:text-sm text-ink-900 placeholder:text-ink-300/70 placeholder:font-normal focus:outline-none focus:ring-0 transition-colors ${mono ? 'font-mono' : ''} ${className}`}
        {...inputProps}
      />
    </label>
  );
});

export default InlineEditor;
