import { Link } from 'react-router-dom';

/**
 * The KPI/summary card pattern — big number on top, eyebrow label,
 * subdued hint underneath, optional icon in a tinted square on the
 * right. This shape repeats verbatim across Dashboard.KpiCard,
 * CustomerDetail.Stat, ProfessionalDetail.SummaryCard, and
 * admin/Commissions.SummaryStat. Centralising here keeps the four
 * surfaces visually identical and means a future tweak to the eyebrow
 * size / number weight changes every one at once.
 *
 * Props
 * -----
 *   label    short uppercase eyebrow ("Comprometido", "Cotizaciones")
 *   value    the headline — typically a money string or count.
 *            Renders as-is; the caller formats.
 *   hint     small grey one-liner below the value. Optional.
 *   icon     lucide-react icon component. Optional.
 *   tone     'ink' | 'brand' | 'emerald'. Controls the icon-square
 *            tint and (when `accent` is set) the left-border accent.
 *            Defaults to 'ink'.
 *   accent   When true, render a 4-px left border in the tone color.
 *            Used in CustomerDetail / ProfessionalDetail summary
 *            cards, not in Dashboard KPIs.
 *   to       Optional react-router path. When set, the card becomes
 *            a Link with a hover-darken on the border. Used in
 *            Dashboard so each KPI click-throughs to the relevant
 *            filtered list.
 */
export default function StatCard({ label, value, hint, icon: Icon, tone = 'ink', accent = false, to }) {
  const iconTint = TONE_ICON[tone] || TONE_ICON.ink;
  const borderClass = accent ? `border-l-4 ${TONE_BORDER[tone] || TONE_BORDER.ink}` : '';

  const inner = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="eyebrow">{label}</div>
        <div className="text-2xl sm:text-3xl font-semibold mt-1.5 tabular-nums truncate text-ink-900">
          {value}
        </div>
        {hint && <div className="text-xs text-ink-500 mt-1">{hint}</div>}
      </div>
      {Icon && (
        <div className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors flex-shrink-0 ${iconTint}`}>
          <Icon size={18} />
        </div>
      )}
    </div>
  );

  const baseClass = `card card-pad ${borderClass}`;
  if (to) {
    return (
      <Link to={to} className={`${baseClass} hover:border-ink-300 transition-colors group block`}>
        {inner}
      </Link>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}

const TONE_ICON = {
  ink:     'text-ink-700 bg-ink-100',
  brand:   'text-brand-700 bg-brand-50',
  emerald: 'text-emerald-600 bg-emerald-50',
};

const TONE_BORDER = {
  ink:     'border-ink-200',
  brand:   'border-brand-200',
  emerald: 'border-emerald-200',
};
