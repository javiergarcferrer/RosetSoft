import { forwardRef } from 'react';
import { DebouncedInput } from '../DebouncedInput.jsx';

/**
 * Inline label:value editor. Reads as flat text until the user hovers or
 * focuses, when a thin baseline appears under the value. On touch devices
 * (no hover) the baseline is permanent so editability is discoverable.
 *
 * Use inside compact "meta strips" — reference numbers, page pointers,
 * dimensions, dates — where surfacing a full <input className="input"> for
 * every field would crush the layout. For form-style fields with labels
 * above the input, use <Field> / <FieldGroup> instead.
 */
const InlineEditor = forwardRef(function InlineEditor({
  label,
  value,
  onCommit,
  placeholder,
  // Tailwind width utility for the input. Picked per-field because inline
  // editors live in a horizontal flow — width hints reading length.
  widthClass = 'w-24',
  // mono = render values in the monospaced UI font (refs, codes, dims).
  mono = false,
  className = '',
  ...inputProps
}, ref) {
  return (
    <label className="inline-flex items-baseline gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-400 select-none">
        {label}
      </span>
      <DebouncedInput
        ref={ref}
        value={value}
        onCommit={onCommit}
        placeholder={placeholder}
        className={`${widthClass} bg-transparent border-0 border-b border-transparent coarse:border-ink-100 hover:border-ink-200 focus:!border-ink-900 px-0 py-1 coarse:min-h-10 text-[13px] coarse:text-[14px] text-ink-900 placeholder:text-ink-300/70 placeholder:font-normal focus:outline-none focus:ring-0 transition-colors ${mono ? 'font-mono' : ''} ${className}`}
        {...inputProps}
      />
    </label>
  );
});

export default InlineEditor;
