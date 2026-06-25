/**
 * Accounting form primitives — the consistent data-entry building blocks for
 * every editor/entry in the module (compra/gasto, factura, cobro, …). The goal
 * is one production-ready look (NetSuite/Odoo/QuickBooks density) instead of
 * each page hand-rolling its own rows.
 *
 * FieldRow is the load-bearing fix for mobile overflow: a label-left row on
 * sm+, but it STACKS (label above control) on a phone, and every control wrapper
 * is `min-w-0` + the control is `w-full`, so a `type="date"`/`type="number"`
 * input can never push past the card edge.
 */

/** A labeled control row. Stacks on mobile, label-left from sm:. */
export function FieldRow({ label, hint, children, className = '' }) {
  return (
    <label className={`block sm:flex sm:items-baseline sm:gap-3 py-2 border-b border-ink-100 min-w-0 ${className}`}>
      <span className="mb-1 sm:mb-0 sm:w-40 sm:shrink-0 inline-flex items-center gap-1 text-[11px] sm:text-xs font-medium text-ink-500 leading-tight">
        {label}{hint}
      </span>
      <div className="min-w-0 sm:flex-1">{children}</div>
    </label>
  );
}

/** A titled group of FieldRows. `cols={2}` lays two columns out on sm+. */
export function FormSection({ title, children, className = '' }) {
  return (
    <section className={className}>
      {title && <h4 className="eyebrow-xs text-ink-400 mb-2">{title}</h4>}
      <div className="border-t border-ink-100">{children}</div>
    </section>
  );
}
