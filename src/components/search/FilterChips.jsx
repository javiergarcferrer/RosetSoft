import { X } from 'lucide-react';

/**
 * Applied-filter tokens — Shopify renders each active secondary filter as a
 * removable chip under the search row, plus a "Clear all" when ≥1 is active.
 *
 * Chips are DERIVED from `activeFilters` (the parent's source of truth) and
 * the `filters` config (so we can resolve a stored value like
 * `createdBy: "uid-123"` to its human label "Creada por · María"). This
 * component never holds filter state — clearing a chip calls back into the
 * parent's onFiltersChange with that key removed.
 *
 * Value→label resolution per filter type:
 *   select      → look up the matching option's label
 *   date-range  → "Desde X" / "Hasta Y" / "X – Y" from {from,to}
 *   text        → the raw string
 * Empty / blank values render no chip (so a half-filled date range with
 * only a "from" still shows one clean chip).
 */
function describeValue(filter, value) {
  if (value == null || value === '') return null;
  if (filter.type === 'select') {
    const opt = (filter.options || []).find((o) => String(o.value) === String(value));
    return opt ? opt.label : String(value);
  }
  if (filter.type === 'date-range') {
    const { from, to } = value || {};
    if (!from && !to) return null;
    if (from && to) return `${from} – ${to}`;
    if (from) return `Desde ${from}`;
    return `Hasta ${to}`;
  }
  // text
  return String(value);
}

export default function FilterChips({ filters, activeFilters, onFiltersChange }) {
  const chips = (filters || [])
    .map((f) => ({ filter: f, text: describeValue(f, activeFilters?.[f.key]) }))
    .filter((c) => c.text != null);

  if (chips.length === 0) return null;

  function clearOne(key) {
    const next = { ...activeFilters };
    delete next[key];
    onFiltersChange(next);
  }

  function clearAll() {
    onFiltersChange({});
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map(({ filter, text }) => (
        <span
          key={filter.key}
          className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 py-1 pl-2.5 pr-1 text-xs text-brand-700 shadow-xs ring-1 ring-inset ring-black/5"
        >
          <span className="text-brand-400 font-normal">{filter.label}:</span>
          <span className="font-semibold text-brand-800">{text}</span>
          <button
            type="button"
            onClick={() => clearOne(filter.key)}
            aria-label={`Quitar filtro ${filter.label}`}
            className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-brand-400 transition-colors hover:bg-brand-100 hover:text-brand-700 active:scale-[0.96]"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={clearAll}
        className="text-xs font-medium text-ink-400 underline-offset-2 transition-colors hover:text-ink-600 hover:underline active:scale-[0.97]"
      >
        Limpiar todo
      </button>
    </div>
  );
}
