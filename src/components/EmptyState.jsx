export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="text-center py-16 px-6 rounded-lg border-2 border-dashed border-ink-200 bg-ink-50">
      {Icon && (
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-ink-100 text-ink-500 mb-3">
          <Icon size={22} />
        </div>
      )}
      <h3 className="text-base font-semibold text-ink-900">{title}</h3>
      {description && <p className="text-sm text-ink-500 mt-1.5 max-w-md mx-auto">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
