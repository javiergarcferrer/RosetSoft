import { forwardRef } from 'react';
import type { ReactNode, SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

export type SelectVariant = 'default' | 'chip' | 'ghost';

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'ref' | 'children'> {
  value: string | number | null | undefined;
  onChange: (value: string) => void;
  children?: ReactNode;
  /**
   * 'default' = full-width input-style select for forms.
   * 'chip'    = compact pill-style for inline use next to other chips.
   * 'ghost'   = borderless click-to-open text-with-chevron.
   */
  variant?: SelectVariant;
  className?: string;
}

/**
 * Styled wrapper over a native <select>. We use the platform widget (not a
 * custom dropdown) for three reasons:
 *
 *   1. iOS / Android render a native picker on tap — wheel on iOS, modal
 *      list on Android. Both are far better thumb interactions than any
 *      JS-rendered menu we could ship at our budget.
 *   2. Accessibility (keyboard nav, screen reader announcements) is free.
 *   3. Form participation works out of the box.
 *
 * The visual chrome — border, hover/focus states, the chevron glyph — sits
 * around the native widget; we hide its built-in arrow via appearance:none
 * (registered globally on the `.select-reset` class so we don't repeat it).
 *
 * `chip` variant compresses the control to a pill that visually pairs with
 * other inline editors (e.g. the grade picker on a line item card).
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({
  value, onChange, children,
  // 'default' = full-width input-style select for forms.
  // 'chip'    = compact pill-style for inline use next to other chips.
  variant = 'default',
  className = '',
  ...selectProps
}, ref) {
  // Variants:
  //   default = full-width input-style select for forms
  //   chip    = compact white pill for inline contexts (next to fields)
  //   ghost   = borderless click-to-open text-with-chevron — reads as
  //             clickable text, not a control. Use when the picker is one
  //             of several inline editors (Linear / Notion property style).
  const base = variant === 'ghost'
    ? 'pl-1.5 pr-5 py-1 text-[13px] coarse:text-sm coarse:py-1.5 coarse:min-h-10 font-medium rounded-md bg-transparent border-0 hover:bg-ink-100/70'
    : variant === 'chip'
      ? 'pl-3 pr-7 py-1.5 text-[13px] coarse:text-sm coarse:py-2 font-medium rounded-md bg-white border border-ink-200 hover:border-ink-300 focus:border-brand-500 focus:shadow-focus min-h-9 coarse:min-h-10'
      : 'w-full px-3 pr-9 py-2 min-h-9 coarse:min-h-11 text-sm rounded-md bg-white border border-ink-200 hover:border-ink-300 focus:border-brand-500 focus:shadow-focus';

  return (
    <div className={`relative inline-flex ${variant === 'default' ? 'w-full' : ''}`}>
      <select
        ref={ref}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none cursor-pointer text-ink-900 transition-colors focus:outline-none ${base} ${className}`}
        {...selectProps}
      >
        {children}
      </select>
      <ChevronDown
        size={variant === 'ghost' ? 12 : 14}
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${
          variant === 'ghost' ? 'right-1 text-ink-400' :
          variant === 'chip'  ? 'right-2 text-ink-500' :
                                'right-3 text-ink-500'
        }`}
        aria-hidden
      />
    </div>
  );
});

export default Select;
