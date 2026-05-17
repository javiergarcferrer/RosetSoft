/**
 * Math / syntax glyph for equation-style layouts: qty × unit = total.
 * Rendered in ink-300 so it reads as syntax, not data. The pb-2 nudge
 * lifts it from the input baseline down to the input's vertical center
 * when sat next to a labelled <CalcCell> — the cells have a label row
 * above the input, so a top-aligned operator would float too high.
 *
 * aria-hidden because screen readers already get the labelled inputs;
 * the operator is purely visual sugar.
 */
export default function Operator({ children, className = '' }) {
  return (
    <span className={`text-ink-300 text-base pb-2 select-none ${className}`} aria-hidden>
      {children}
    </span>
  );
}
