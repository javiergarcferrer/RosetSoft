export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6 pb-4 border-b border-ink-100">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
