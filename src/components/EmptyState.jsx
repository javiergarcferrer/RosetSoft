export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="text-center py-14 px-8 rounded-xl border border-dashed border-ink-200/80 bg-ink-50/40">
      {Icon && (
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-surface border border-ink-100 shadow-xs text-ink-400 mb-4 ring-1 ring-inset ring-black/[0.04]">
          <Icon size={22} strokeWidth={1.5} aria-hidden />
        </div>
      )}
      <h3 className="font-display text-sm font-semibold text-ink-700">{title}</h3>
      {description && (
        <p className="text-xs text-ink-400 mt-1.5 max-w-[22rem] mx-auto leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
