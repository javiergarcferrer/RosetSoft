import { Search } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import FilterTabs from './FilterTabs.jsx';
import FilterBar from './FilterBar.jsx';
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
 *   2. Sort menu — pick the sort key + explicit asc/desc control.
 *   3. Filter tabs — the primary status dimension as a scrollable segmented
 *      "saved views" strip (Todas / Borrador / …).
 *   4. Filter pills — ONE always-visible pill per secondary filter
 *      (select / date-range / text), each opening its own popover (desktop)
 *      or sheet (mobile). Changes apply INSTANTLY — no Aplicar step — and an
 *      applied pill reads `Label: value ×` (see FilterBar).
 *   5. Result count — quiet "N resultados" line.
 *
 * Layout: search grows to fill the row; Sort sits to its right and wraps
 * below it on a narrow phone (flex-wrap), so nothing is ever clipped. The
 * tab strip and the pills row live beneath, scrollable/wrapping on mobile.
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
    <div className="mb-5 space-y-2.5">
      {/* Row 1 — search + the two menu triggers. Wraps on a narrow phone. */}
      <div className="flex flex-wrap items-center gap-2">
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

        {hasSort && (
          <SortMenu sortOptions={sortOptions} sort={sort} onSortChange={onSortChange} />
        )}
      </div>

      {/* Row 2 — segmented status views. */}
      {hasTabs && (
        <FilterTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
      )}

      {/* Row 3 — per-filter pills, instant apply (renders nothing if none). */}
      {hasFilters && (
        <FilterBar
          filters={filters}
          activeFilters={activeFilters}
          onFiltersChange={onFiltersChange}
        />
      )}

      {/* Row 4 — quiet result count; tabular-nums keeps the digit from jumping. */}
      {typeof resultCount === 'number' && (
        <p className="text-[11px] tabular-nums text-ink-400 leading-none" aria-live="polite">
          <span className="font-semibold text-ink-500">{resultCount}</span>
          {' '}
          {resultCount === 1 ? resultNoun[0] : resultNoun[1]}
        </p>
      )}
    </div>
  );
}
