import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Store as StoreIcon, PackageSearch, Layers } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import StatusPill from '../components/StatusPill.jsx';
import ImageView from '../components/ImageView.jsx';
import ShipmentTracking from '../components/ShipmentTracking.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatMoney } from '../lib/format.js';
import { effectiveRates } from '../lib/exchangeRate.js';
import { swatchUrl } from '../lib/swatchImage.js';
import {
  resolveStore, STORE_VIEW_MERCHANDISE, STORE_VIEW_MATERIALS,
} from '../core/store/index.js';

/**
 * Tienda — the showroom / ecommerce browse surface.
 *
 * One page, two segments behind a toggle:
 *   • Mercancía  — the articles Alcover has on its orders (a quote line attached
 *                  to an order), each a product photo + DOP price + availability
 *                  badge; "En camino" items expand to live container tracking.
 *   • Materiales — the fabric / leather / outdoor catalog, searchable down to the
 *                  individual color / LR code.
 *
 * MVVM: every figure, count, tab and sorted list is a pure projection from
 * `resolveStore` (core/store). This page only holds the interactive state
 * (segment / search / tab / filters / sort), fetches the rows, and renders.
 */

const DEFAULT_SORT = {
  [STORE_VIEW_MERCHANDISE]: { key: 'availability', dir: 'asc' },
  [STORE_VIEW_MATERIALS]: { key: 'name', dir: 'asc' },
};

const SEARCH_PLACEHOLDER = {
  [STORE_VIEW_MERCHANDISE]: 'Buscar artículo, familia o referencia…',
  [STORE_VIEW_MATERIALS]: 'Buscar material, color o grado…',
};

const RESULT_NOUN = {
  [STORE_VIEW_MERCHANDISE]: ['artículo', 'artículos'],
  [STORE_VIEW_MATERIALS]: ['material', 'materiales'],
};

const UNIT_LABEL = { yard: 'yd', sm: 'm²' };

export default function Store() {
  const { profileId, settings } = useApp();
  const rates = useMemo(() => effectiveRates(settings), [settings]);

  // Gate the first paint on every dataset the active segment reads, so the
  // segment-toggle counts and the grid never flash an empty state before the
  // rows land (merchandise needs orders + quotes + lines; materials needs
  // materials). Containers are additive — tracking just appears once they load —
  // so they don't gate.
  const { data: orders, loaded: ordersLoaded } = useLiveQueryStatus(
    () => db.orders.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: materials, loaded: materialsLoaded } = useLiveQueryStatus(
    () => db.materials.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: quotes, loaded: quotesLoaded } = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: lines, loaded: linesLoaded } = useLiveQueryStatus(
    () => db.quoteLines.toArray(), [], [],
  );
  const containers = useLiveQuery(
    () => db.containers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );

  const [view, setView] = useState(STORE_VIEW_MERCHANDISE);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState(DEFAULT_SORT[STORE_VIEW_MERCHANDISE]);

  // The tabs / secondary filters / sort keys differ per segment, so reset them
  // (but keep the search needle) when the dealer flips the toggle.
  function switchView(next) {
    if (next === view) return;
    setView(next);
    setTab('all');
    setFilters({});
    setSort(DEFAULT_SORT[next]);
  }

  const { items, resultCount, tabs, filterDefs, sortOptions, segments } = useMemo(
    () => resolveStore({
      quotes, lines, orders, containers, materials,
      view, q, tab, filters, sort,
    }),
    [quotes, lines, orders, containers, materials, view, q, tab, filters, sort],
  );

  const loaded = view === STORE_VIEW_MATERIALS
    ? materialsLoaded
    : ordersLoaded && quotesLoaded && linesLoaded;

  return (
    <>
      <PageHeader
        title="Tienda"
        subtitle="Mercancía disponible y en camino · catálogo de materiales"
      />

      {/* Segment toggle — Mercancía vs Materiales, each with its live count. */}
      <div className="mb-4 inline-flex rounded-lg border border-ink-200 bg-white p-0.5">
        {segments.map((s) => {
          const active = s.key === view;
          const Icon = s.key === STORE_VIEW_MATERIALS ? Layers : PackageSearch;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => switchView(s.key)}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                active ? 'bg-ink-900 text-ink-50' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
              }`}
            >
              <Icon size={14} />
              {s.label}
              <span
                className={`tabular-nums rounded px-1.5 py-px text-[11px] font-semibold ${
                  active ? 'bg-white/20 text-ink-50' : 'bg-ink-100 text-ink-500'
                }`}
              >
                {s.count}
              </span>
            </button>
          );
        })}
      </div>

      <ListSearchHeader
        searchValue={q}
        onSearchChange={setQ}
        searchPlaceholder={SEARCH_PLACEHOLDER[view]}
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        filters={filterDefs}
        activeFilters={filters}
        onFiltersChange={setFilters}
        sortOptions={sortOptions}
        sort={sort}
        onSortChange={setSort}
        resultCount={resultCount}
        resultNoun={RESULT_NOUN[view]}
      />

      {!loaded ? (
        <SkeletonGrid />
      ) : items.length === 0 ? (
        <EmptyState
          icon={StoreIcon}
          title={view === STORE_VIEW_MATERIALS ? 'Sin materiales' : 'Sin mercancía'}
          description={
            view === STORE_VIEW_MATERIALS
              ? 'No hay materiales que coincidan con tu búsqueda.'
              : 'Aquí aparece la mercancía de tus pedidos. Adjunta una cotización a un pedido y sus artículos se listan aquí, con su disponibilidad y seguimiento de contenedor.'
          }
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {items.map((c) =>
            c.kind === 'material' ? (
              <MaterialCard key={c.id} c={c} rates={rates} />
            ) : (
              <MerchandiseCard key={c.key} c={c} rates={rates} />
            ),
          )}
        </div>
      )}
    </>
  );
}

/* --------------------------------- pricing ---------------------------------- */

// Format a store price (point value or min–max range) in DOP.
function priceLabel(price, rates) {
  if (!price) return '—';
  if (price.value != null) return formatMoney(price.value, 'DOP', rates);
  return `${formatMoney(price.min, 'DOP', rates)} – ${formatMoney(price.max, 'DOP', rates)}`;
}

/* ---------------------------------- cards ----------------------------------- */

function MerchandiseCard({ c, rates }) {
  const to = c.orderIds.length ? `/orders/${c.orderIds[0]}` : null;
  const meta = [c.family, c.subtype].filter(Boolean).join(' · ');
  const head = (
    <>
      <div className="relative aspect-square bg-ink-50">
        <ImageView
          id={c.imageId}
          alt={c.name}
          className="w-full h-full object-contain"
          placeholderClassName="w-full h-full"
        />
        <div className="absolute top-2 left-2">
          <StatusPill cls={c.availability.pillCls} label={c.availability.label} />
        </div>
      </div>
      <div className="px-3 pt-2.5">
        <div className="text-sm font-semibold leading-tight line-clamp-2" title={c.name}>{c.name}</div>
        {meta && <div className="text-xs text-ink-500 truncate mt-0.5" title={meta}>{meta}</div>}
      </div>
    </>
  );

  return (
    <div className="card overflow-hidden flex flex-col">
      {to ? <Link to={to} className="block">{head}</Link> : head}
      <div className="px-3 pb-3 pt-1 flex flex-col gap-1 flex-1">
        <div className="mt-auto flex items-baseline justify-between gap-2">
          <div className="text-sm font-medium text-ink-900">{priceLabel(c.price, rates)}</div>
          <div className="text-[11px] text-ink-500 whitespace-nowrap">
            {c.qty} ud.{c.orderCount > 1 ? ` · ${c.orderCount} pedidos` : ''}
          </div>
        </div>
        {/* Incoming merchandise → live container tracking. Renders nothing when
            the order has no trackable (valid ISO 6346) container. */}
        {c.trackable.length > 0 && (
          <ShipmentTracking containers={c.trackable} collapsible className="pt-1" />
        )}
      </div>
    </div>
  );
}

function MaterialCard({ c, rates }) {
  const meta = [c.categoryLabel, c.grade && `Grado ${c.grade}`, c.wearRating]
    .filter(Boolean)
    .join(' · ');
  const price = c.price
    ? `${formatMoney(c.price.value, 'DOP', rates)}${c.price.unit ? ` /${UNIT_LABEL[c.price.unit] || c.price.unit}` : ''}`
    : '—';
  return (
    <div className="card overflow-hidden flex flex-col">
      <div className="relative aspect-square bg-ink-50">
        <ImageView
          id={c.imageId}
          fallbackUrl={swatchUrl(c.heroColorCode)}
          alt={c.name}
          className="w-full h-full object-cover"
          placeholderClassName="w-full h-full"
        />
      </div>
      <div className="p-3 flex flex-col gap-1 flex-1">
        <div className="text-sm font-semibold leading-tight line-clamp-2" title={c.name}>{c.name}</div>
        {meta && <div className="text-xs text-ink-500 truncate" title={meta}>{meta}</div>}
        <div className="mt-auto flex items-baseline justify-between gap-2 pt-1">
          <div className="text-sm font-medium text-ink-900">{price}</div>
          {c.colorCount > 0 && (
            <div className="text-[11px] text-ink-500 whitespace-nowrap">
              {c.colorCount} {c.colorCount === 1 ? 'color' : 'colores'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- skeleton ---------------------------------- */

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="card overflow-hidden">
          <div className="aspect-square bg-ink-100 animate-pulse" />
          <div className="p-3 space-y-2">
            <div className="h-3.5 bg-ink-100 rounded animate-pulse" />
            <div className="h-3 w-2/3 bg-ink-100 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
