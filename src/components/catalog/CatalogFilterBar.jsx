import { Search, ChevronDown, X } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';

/**
 * CatalogFilterBar — the Shopify-style refine toolbar shown INSIDE an opened
 * catalog category (and above search results). Purely presentational: it owns
 * no filtering logic, just renders the controls for a `{ text, min, max, sort }`
 * value and emits the next value; the PARENT derives the filtered/sorted model
 * list (Catalog.jsx's filterModels/sortModels).
 *
 * Anatomy (one horizontally-scrollable row + a chips row when active):
 *   1. Quick text filter — debounced ~150ms, client-side over loaded models.
 *   2. Precio dropdown — Min/Max USD inputs applied to each model's range.
 *   3. Sort select — Nombre A–Z / Precio ↑ / Precio ↓ / Más SKUs.
 *   4. Active-filter chips with one-tap clear + "Limpiar" + "X de Y modelos".
 *
 * Sticky: the bar pins to the top of the scrollport while the list scrolls
 * (the parent card uses overflow-clip, which — unlike overflow-hidden — keeps
 * position:sticky working against the page scroll).
 */

export const CATALOG_SORTS = [
  { key: 'name', label: 'Nombre A–Z' },
  { key: 'priceAsc', label: 'Precio ↑' },
  { key: 'priceDesc', label: 'Precio ↓' },
  { key: 'skus', label: 'Más SKUs' },
];

/** The neutral state — also what "Limpiar" resets to (sort is not a filter). */
export const DEFAULT_CATALOG_FILTERS = { text: '', min: '', max: '', sort: 'name' };

/** True when any narrowing filter (not the sort) is applied. */
export function hasActiveCatalogFilters(f) {
  return !!((f.text || '').trim() || f.min !== '' || f.max !== '');
}

function priceChipLabel(min, max) {
  if (min !== '' && max !== '') return `$${min} – $${max}`;
  if (min !== '') return `≥ $${min}`;
  return `≤ $${max}`;
}

/** Close the enclosing <details> popover (the "Listo" button + chip clears). */
function closePopover(e) {
  e.currentTarget.closest('details')?.removeAttribute('open');
}

export default function CatalogFilterBar({
  value,
  onChange,
  shown,
  total,
  placeholder = 'Filtrar en esta categoría…',
}) {
  const set = (patch) => onChange({ ...value, ...patch });
  const active = hasActiveCatalogFilters(value);
  const priceActive = value.min !== '' || value.max !== '';
  const textActive = (value.text || '').trim().length > 0;

  return (
    <div className="sticky top-0 z-10 border-b border-ink-100 bg-white/95 backdrop-blur px-3 sm:px-5 py-2 space-y-2">
      {/* Controls row — scrolls horizontally on a narrow phone, never wraps. */}
      <div className="flex items-center gap-2 overflow-x-auto">
        <div className="relative flex-1 min-w-[150px]">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400"
            aria-hidden
          />
          <DebouncedInput
            className="input pl-8 text-xs"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={placeholder}
            value={value.text}
            onCommit={(v) => set({ text: v })}
            delay={150}
            placeholder={placeholder}
          />
        </div>

        {/* Precio — min/max USD popover. */}
        <details className="relative flex-shrink-0">
          <summary
            className={`btn-secondary list-none select-none cursor-pointer text-xs [&::-webkit-details-marker]:hidden ${
              priceActive ? '!border-brand-300 !text-brand-700' : ''
            }`}
          >
            {priceActive ? priceChipLabel(value.min, value.max) : 'Precio'}
            <ChevronDown size={13} aria-hidden />
          </summary>
          <div className="absolute right-0 z-20 mt-1.5 w-60 rounded-xl border border-ink-200 bg-white p-3 shadow-md">
            <p className="eyebrow-xs mb-2">Rango de precio (USD)</p>
            <div className="flex items-center gap-2">
              <DebouncedInput
                className="input text-xs"
                type="number"
                inputMode="decimal"
                min="0"
                aria-label="Precio mínimo USD"
                placeholder="Mín"
                value={value.min}
                onCommit={(v) => set({ min: v })}
                delay={150}
              />
              <span className="text-ink-400 text-xs flex-shrink-0">–</span>
              <DebouncedInput
                className="input text-xs"
                type="number"
                inputMode="decimal"
                min="0"
                aria-label="Precio máximo USD"
                placeholder="Máx"
                value={value.max}
                onCommit={(v) => set({ max: v })}
                delay={150}
              />
            </div>
            <div className="mt-2.5 flex items-center justify-between">
              <button
                type="button"
                className="text-xs text-ink-500 hover:text-ink-900"
                onClick={(e) => { set({ min: '', max: '' }); closePopover(e); }}
              >
                Limpiar
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={closePopover}>
                Listo
              </button>
            </div>
          </div>
        </details>

        {/* Sort — native select, compact and touch-friendly. */}
        <select
          className="input w-auto flex-shrink-0 text-xs"
          aria-label="Ordenar modelos"
          value={value.sort}
          onChange={(e) => set({ sort: e.target.value })}
        >
          {CATALOG_SORTS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Chips row — one removable token per active filter + clear-all + count. */}
      {active && (
        <div className="flex flex-wrap items-center gap-1.5">
          {textActive && (
            <FilterChip label={`“${value.text.trim()}”`} onClear={() => set({ text: '' })} />
          )}
          {priceActive && (
            <FilterChip
              label={priceChipLabel(value.min, value.max)}
              onClear={() => set({ min: '', max: '' })}
            />
          )}
          <button
            type="button"
            className="text-[11px] font-medium text-ink-500 hover:text-ink-900 px-1"
            onClick={() => onChange({ ...DEFAULT_CATALOG_FILTERS, sort: value.sort })}
          >
            Limpiar
          </button>
          {typeof shown === 'number' && typeof total === 'number' && (
            <span className="ml-auto text-[11px] tabular-nums text-ink-400" aria-live="polite">
              {shown} de {total} modelos
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, onClear }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 border border-ink-200/70 pl-2.5 pr-1 py-0.5 text-[11px] font-medium text-ink-700 max-w-[200px]">
      <span className="truncate">{label}</span>
      <button
        type="button"
        className="rounded-full p-0.5 text-ink-400 hover:text-ink-900 hover:bg-ink-200"
        aria-label={`Quitar filtro ${label}`}
        onClick={onClear}
      >
        <X size={11} aria-hidden />
      </button>
    </span>
  );
}
