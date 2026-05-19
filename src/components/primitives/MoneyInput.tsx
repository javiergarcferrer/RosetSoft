import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { DebouncedInput } from '../DebouncedInput.js';

export interface MoneyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'ref'> {
  value: number | string | null | undefined;
  onCommit: (value: number) => void;
  currency?: string;
  placeholder?: string;
  /**
   * Min-width class applied directly to the <input>. The input also
   * carries `field-sizing: content` (via qli-grow) so it grows past
   * this min when the value has more digits. A 6-figure money string
   * can't be clipped because the field expands to fit it. max-w-full
   * keeps it from forcing the parent wider than its own container —
   * when that happens the parent's flex-wrap drops it onto a new row.
   */
  widthClass?: string;
  className?: string;
}

/**
 * Number input with a leading currency glyph. Always right-aligned, always
 * tabular-numerals — digits line up vertically when stacked across rows
 * (totals tables, line money columns).
 *
 * The glyph is a positioned overlay, not part of the value, so the input
 * accepts plain numeric input and the iOS number pad still appears. The
 * onCommit value is coerced to a non-negative Number — pass an integer
 * normaliser via the wrapping context if rounding is needed.
 *
 * For non-currency numbers, use <DebouncedInput type="number" />.
 */
const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput({
  value,
  onCommit,
  currency = 'USD',
  placeholder = '0',
  // Min-width class applied directly to the <input>. The input also
  // carries `field-sizing: content` (via qli-grow) so it grows past
  // this min when the value has more digits. A 6-figure money string
  // can't be clipped because the field expands to fit it. max-w-full
  // keeps it from forcing the parent wider than its own container —
  // when that happens the parent's flex-wrap drops it onto a new row.
  widthClass = 'min-w-[7rem]',
  className = '',
  ...inputProps
}, ref) {
  const symbol = currencyGlyph(currency);
  return (
    <div className="relative inline-block max-w-full">
      <span
        className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-400 text-sm pointer-events-none select-none tabular-nums"
        aria-hidden
      >
        {symbol}
      </span>
      <DebouncedInput
        ref={ref}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        placeholder={placeholder}
        value={value ?? ''}
        onCommit={(v) => onCommit(Math.max(0, Number(v) || 0))}
        className={`qli-grow ${widthClass} max-w-full text-right tabular-nums input min-h-9 coarse:min-h-10 py-1.5 pl-6 pr-2 ${className}`}
        {...inputProps}
      />
    </div>
  );
});

// Just the prefixes that show up in the DR market. Everything else falls
// back to the ISO code + space so the user still has context.
function currencyGlyph(code: string): string {
  if (code === 'USD' || code === 'DOP') return '$';
  if (code === 'EUR') return '€';
  if (code === 'GBP') return '£';
  return code + ' ';
}

export default MoneyInput;
