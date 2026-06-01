import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, Store as StoreIcon, SearchX } from 'lucide-react';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import StatusPill from '../components/StatusPill.jsx';
import ImageView from '../components/ImageView.jsx';
import { formatMoney } from '../lib/format.js';
import { fetchStoreCatalog } from '../lib/storefront.js';
import { resolveStore } from '../core/store/index.js';

/**
 * Public, logged-OUT storefront ("Tienda", route #/tienda).
 *
 * Fetches the public catalog from the `store` Edge Function (the products from
 * the dealer's house-account quotes, margin baked, no cost/markup) and lets a
 * visitor browse it: search, filter by family, sort, and a status tab for
 * Disponible / En camino / Pedido. Every figure is a projection from
 * `resolveStore` (core/store); the page only holds the search/tab/filter/sort
 * state and renders.
 *
 * Renders OUTSIDE the app's auth shell, so it leans on no AppContext / session —
 * only the bundle it fetches and <ImageView>'s public-bucket reads.
 */
export default function PublicStore() {
  const [state, setState] = useState({ status: 'loading', bundle: null, error: null });
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState({ key: 'availability', dir: 'asc' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', bundle: null, error: null });
    fetchStoreCatalog()
      .then((bundle) => { if (active) setState({ status: 'ready', bundle, error: null }); })
      .catch((e) => { if (active) setState({ status: 'error', bundle: null, error: e?.message || 'error' }); });
    return () => { active = false; };
  }, []);

  const bundle = state.bundle;

  const { items, resultCount, tabs, filterDefs, sortOptions } = useMemo(
    () => resolveStore({
      quotes: bundle?.quotes || [],
      lines: bundle?.lines || [],
      orders: bundle?.orders || [],
      q, tab, filters, sort,
    }),
    [bundle, q, tab, filters, sort],
  );

  // Title the tab with the store name, restored on unmount.
  useEffect(() => {
    if (!bundle) return undefined;
    const prev = document.title;
    document.title = bundle.storeName ? `Tienda · ${bundle.storeName}` : 'Tienda';
    return () => { document.title = prev; };
  }, [bundle]);

  if (state.status === 'loading') {
    return (
      <div className="h-full flex items-center justify-center bg-ink-50 text-ink-500">
        <Loader2 className="animate-spin mr-2" size={18} /> Cargando tienda…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-ink-50 text-center px-6">
        <AlertCircle className="text-ink-400 mb-3" size={32} />
        <div className="text-lg font-semibold text-ink-800">Tienda no disponible</div>
        <p className="text-sm text-ink-500 mt-1 max-w-sm">
          No se pudo cargar la tienda en este momento. Inténtalo de nuevo en unos minutos.
        </p>
      </div>
    );
  }

  // Total products across the catalog (pre-filter) — the "all" tab count. Lets
  // us tell "store not set up / empty" apart from "your search matched nothing".
  const totalProducts = tabs.find((t) => t.key === 'all')?.count || 0;
  const notReady = !bundle.configured || totalProducts === 0;

  return (
    // Lives outside the app shell: be our own scroll container (html/body/#root
    // are pinned in index.css), or the grid is clipped at the fold on mobile.
    <div className="h-full overflow-y-auto overscroll-contain bg-ink-50 py-6 px-3 sm:px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex items-center gap-3">
          {bundle.logoImageId ? (
            <ImageView
              id={bundle.logoImageId}
              alt={bundle.storeName || 'Tienda'}
              className="h-9 max-w-[160px] object-contain object-left"
              placeholderClassName="h-9 w-9"
            />
          ) : (
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-ink-900 text-white">
              <StoreIcon size={18} />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight leading-tight truncate">
              {bundle.storeName || 'Tienda'}
            </h1>
            <p className="text-xs text-ink-500">Catálogo disponible y en camino</p>
          </div>
        </header>

        {notReady ? (
          <EmptyStore configured={bundle.configured} />
        ) : (
          <>
            <ListSearchHeader
              searchValue={q}
              onSearchChange={setQ}
              searchPlaceholder="Buscar artículo, familia o referencia…"
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
              resultNoun={['artículo', 'artículos']}
            />
            {items.length === 0 ? (
              <div className="text-center py-16 px-6 rounded-lg border-2 border-dashed border-ink-200 bg-white">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-ink-100 text-ink-500 mb-3">
                  <SearchX size={22} />
                </div>
                <h3 className="text-base font-semibold text-ink-900">Sin resultados</h3>
                <p className="text-sm text-ink-500 mt-1.5">
                  Ningún artículo coincide con tu búsqueda o filtros.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
                {items.map((c) => <ProductCard key={c.key} c={c} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Format a store price (point value or min–max range) in USD.
function priceLabel(price) {
  if (!price) return '—';
  if (price.value != null) return formatMoney(price.value, 'USD');
  return `${formatMoney(price.min, 'USD')} – ${formatMoney(price.max, 'USD')}`;
}

function ProductCard({ c }) {
  const meta = [c.family, c.subtype].filter(Boolean).join(' · ');
  return (
    <div className="card overflow-hidden flex flex-col bg-white">
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
        {/* Fabric swatch chip — the material this piece is shown in. */}
        {c.swatchImageId && (
          <div
            className="absolute bottom-2 right-2 h-9 w-9 overflow-hidden rounded-md border-2 border-white bg-white shadow-md"
            title="Tela"
          >
            <ImageView
              id={c.swatchImageId}
              alt=""
              className="h-full w-full object-cover"
              placeholderClassName="h-full w-full"
            />
          </div>
        )}
      </div>
      <div className="p-3 flex flex-col gap-1 flex-1">
        <div className="text-sm font-semibold leading-tight line-clamp-2" title={c.name}>{c.name}</div>
        {meta && <div className="text-xs text-ink-500 truncate" title={meta}>{meta}</div>}
        <div className="mt-auto pt-1 text-sm font-medium text-ink-900">{priceLabel(c.price)}</div>
      </div>
    </div>
  );
}

function EmptyStore({ configured }) {
  return (
    <div className="text-center py-20 px-6 rounded-lg border-2 border-dashed border-ink-200 bg-white">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-ink-100 text-ink-500 mb-3">
        <StoreIcon size={22} />
      </div>
      <h3 className="text-base font-semibold text-ink-900">Tienda en preparación</h3>
      <p className="text-sm text-ink-500 mt-1.5 max-w-md mx-auto">
        {configured
          ? 'Aún no hay productos publicados. Vuelve pronto.'
          : 'Estamos preparando nuestro catálogo. Vuelve pronto para ver la mercancía disponible y en camino.'}
      </p>
    </div>
  );
}
