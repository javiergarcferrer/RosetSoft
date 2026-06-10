import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { DebouncedTextarea } from '../DebouncedInput.js';

export interface HeroInputProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'ref'> {
  value: string | number | null | undefined;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Borderless title-weight field that doubles as a heading. The kind of
 * input that should read as the H2 of a card but still accept typing — line
 * item names, quote titles, customer names in dialog headers.
 *
 * Implemented as an auto-resizing single-row textarea (not an <input>) so
 * long values wrap onto multiple lines instead of horizontally scrolling
 * out of sight on narrow viewports. Auto-resize is driven by scrollHeight,
 * not by the new CSS `field-sizing: content` property, because the latter
 * only landed in Chrome 123 / Safari 17.4 and we want consistent behavior
 * on older mobile browsers.
 *
 * Hover paints a soft tint (advertises editability on fine pointers);
 * focus pins a 1-px inset border (a clear edit affordance without the
 * visual weight of full input chrome).
 *
 * For form fields with a label above, use <input className="input" />.
 * For meta-strip fields, use <InlineEditor>.
 */
const HeroInput = forwardRef<HTMLTextAreaElement, HeroInputProps>(function HeroInput({
  value, onCommit, placeholder, className = '', ...inputProps
}, ref) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  // Forward the underlying <textarea> so callers can .focus() / .select() /
  // .scrollIntoView() it directly — same contract as a plain <input>.
  useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement, []);

  // Resize on every value change. We bypass React's controlled-value latch
  // by reading the DOM node directly because DebouncedTextarea may not
  // have flushed the new local value to `value` yet (it debounces commits).
  useEffect(() => {
    autoSize(innerRef.current);
  }, [value]);

  return (
    <DebouncedTextarea
      ref={innerRef}
      value={value}
      onCommit={onCommit}
      placeholder={placeholder}
      rows={1}
      // Block the Enter key so users can't insert literal newlines into a
      // product name (the PDF and totals rail render names on one logical
      // line per item; embedded \n would create blank rows there).
      // Shift+Enter still allowed for power users who want to break by hand.
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) e.preventDefault(); }}
      onInput={(e) => autoSize(e.currentTarget)}
      className={`block w-full bg-transparent border-0 px-1 -mx-1 py-0.5 -my-0.5 rounded resize-none overflow-hidden text-[15px] leading-snug font-semibold text-ink-900 placeholder:text-ink-300 placeholder:font-medium hover:bg-ink-50 focus:bg-white focus:shadow-[inset_0_0_0_1px_theme('colors.brand.400')] focus:outline-none transition-colors ${className}`}
      {...inputProps}
    />
  );
});

function autoSize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  // Reset to auto first so shrinking content is honored — otherwise the
  // height stays at the previous scrollHeight even after a value is deleted.
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

export default HeroInput;
