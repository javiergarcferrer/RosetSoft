/**
 * Presentational status pill. Pairs with the resolvers in lib/statusPill
 * (quoteStagePill / orderStatusPill) so a status renders the same way
 * everywhere:
 *
 *   <StatusPill {...quoteStagePill(stage)} />
 *
 * `cls` is the `.status-pill-*` variant; `label` the Spanish text. Extra
 * `className` (e.g. flex-shrink-0) and leading `children` (a status dot/icon)
 * are passed through.
 */
export default function StatusPill({ cls, label, className = '', children }) {
  return (
    <span className={`status-pill ${cls} font-medium tracking-[0.02em]${className ? ` ${className}` : ''}`}>
      {children && <span className="inline-flex items-center mr-1" aria-hidden>{children}</span>}
      {label}
    </span>
  );
}
