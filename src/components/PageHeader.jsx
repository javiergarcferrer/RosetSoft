export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-5 pb-4 border-b border-ink-100">
      <div className="min-w-0">
        <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-tight leading-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-500 mt-1.5 leading-snug">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">{actions}</div>}
    </div>
  );
}
