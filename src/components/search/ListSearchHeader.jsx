import { Search } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import FilterTabs from './FilterTabs.jsx';
import FilterPopover from './FilterPopover.jsx';
import FilterChips from './FilterChips.jsx';
import SortMenu from './SortMenu.jsx';

/**
 * ListSearchHeader — the one Shopify-admin-inspired search / filter header
 * reused across every list view in the app (Quotes, Customers, Profesionales,
 * Materiales, Contabilidad). It is deliberately VIEW-AGNOSTIC: it holds no
 * domain logic, owns no state, and never filters anything itself. It takes a
 * declarative config + the current query state and emits changes; the PARENT
 * does the actual filtering / sorting on its own data. That contract is what
 * lets the same component dress five different surfaces.
 *
 * Anatomy (top → bottom), each part rendered only if its config is supplied:
 *   1. Search field — debounced, leading search icon, enterKeyHint="search".
 *   2. Filtros button — opens a sheet (mobile) / popover (desktop) of
 *      secondary filters (select / date-range / text).
 *   3. Sort menu — pick the sort key + flip direction.
 *   4. Filter tabs — the primary status dimension as a scrollable segmented
 *      "saved views" strip (Todas / Borrador / …).
 *   5. Applied-filter chips — one removable token per active secondary
 *      filter + "Limpiar todo".
 *   6. Result count — quiet "N resultados" line.
 *
 * Layout: search grows to fill the row; Filtros + Sort sit to its right and
 * wrap below it on a narrow phone (flex-wrap), so nothing is ever clipped.
 * The tab strip lives on its own row beneath, scrollable on mobile.
 *
 * PROP API (the public surface — keep this stable for the other views):
 *
 *   searchValue: string
 *   onSearchChange: (value: string) => void
 *   searchPlaceholder?: string
 *   searchDelay?: number                       // debounce ms, default 250
 *
 *   tabs?: Array<{ key: string, label: string, count?: number }>
 *   activeTab?: string
 *   onTabChange?: (key: string) => void
 *
 *   filters?: Array<{
 *     key: string,
 *     label: string,
 *     type: 'select' | 'date-range' | 'text',
 *     options?: Array<{ value: string, label: string }>,   // for 'select'
 *     placeholder?: string,
 *   }>
 *   activeFilters?: { [key: string]: string | { from?: string, to?: string } }
 *   onFiltersChange?: (next: object) => void
 *
 *   sortOptions?: Array<{ key: string, label: string }>
 *   sort?: { key: string, dir: 'asc' | 'desc' }
 *   onSortChange?: ({ key, dir }) => void
 *
 *   resultCount?: number
 *   resultNoun?: [singular, plural]            // e.g. ['resultado','resultados']
 */
export default function ListSearchHeader({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Buscar…',
  searchDelay = 250,
  tabs,
  activeTab,
  onTabChange,
  filters,
  activeFilters = {},
  onFiltersChange,
  sortOptions,
  sort,
  onSortChange,
  resultCount,
  resultNoun = ['resultado', 'resultados'],
}) {
  const hasFilters = Array.isArray(filters) && filters.length > 0;
  const hasSort = Array.isArray(sortOptions) && sortOptions.length > 0;
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;

  return (
    <div className="mb-5 space-y-3">
      {/* Row 1 — search + the two menu triggers. Wraps on a narrow phone. */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
            aria-hidden
          />
          <DebouncedInput
            className="input pl-9"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={searchPlaceholder}
            value={searchValue}
            onCommit={onSearchChange}
            delay={searchDelay}
            placeholder={searchPlaceholder}
          />
        </div>

        {hasFilters && (
          <FilterPopover
            filters={filters}
            activeFilters={activeFilters}
            onFiltersChange={onFiltersChange}
          />
        )}

        {hasSort && (
          <SortMenu sortOptions={sortOptions} sort={sort} onSortChange={onSortChange} />
        )}
      </div>

      {/* Row 2 — segmented status views. */}
      {hasTabs && (
        <FilterTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
      )}

      {/* Row 3 — applied secondary-filter chips (renders nothing if none). */}
      {hasFilters && (
        <FilterChips
          filters={filters}
          activeFilters={activeFilters}
          onFiltersChange={onFiltersChange}
        />
      )}

      {/* Row 4 — quiet result count. */}
      {typeof resultCount === 'number' && (
        <p className="text-xs text-ink-500" aria-live="polite">
          {resultCount} {resultCount === 1 ? resultNoun[0] : resultNoun[1]}
        </p>
      )}
    </div>
  );
}
