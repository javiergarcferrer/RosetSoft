import { userMessageFor } from '../lib/errorMessages.js';
import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, RefreshCw, Store as StoreIcon, Search, MessageCircle, Phone } from 'lucide-react';
import FilterPopover from '../components/search/FilterPopover.jsx';
import SortMenu from '../components/search/SortMenu.jsx';
import { DebouncedInput } from '../components/DebouncedInput.jsx';
import ImageView from '../components/ImageView.jsx';
import { formatMoney } from '../lib/format.js';
import { fetchStoreCatalog, contactLinkFor } from '../lib/storefront.js';
import { resolveStore } from '../core/store/index.js';

/**
 * Public, logged-OUT storefront ("Tienda", route #/tienda).
 *
 * Fetches the public catalog from the `store` Edge Function (the products from
 * the dealer's house-account quotes, margin baked, no cost/markup) and presents
 * it as an editorial, fashion-house-style lookbook: a warm-paper ground, a slim
 * centered wordmark, an eyebrow + large title with the count, tucked-away
 * filter / search / sort, and a big borderless image grid with quiet name/price
 * captions. Every figure is a projection from `resolveStore` (core/store); the
 * page only holds the search/tab/filter/sort state and renders.
 *
 * Renders OUTSIDE the app's auth shell, so it leans on no AppContext / session —
 * only the bundle it fetches and <ImageView>'s public-bucket reads. The page is
 * its own scroll container (html/body/#root are pinned in index.css).
 */
// The lookbook's own warm-paper tones — deliberately a step warmer than the
// app canvas (#f3f1ed), centralized here so the page carries ONE source for
// each. Candidates for proper `store-paper` / `store-tile` tokens in
// tailwind.config if a second surface ever adopts them.
const PAPER = 'bg-[#f4f0e8]';
const PAPER_GLASS = 'bg-[#f4f0e8]/90';
const TILE = 'bg-[#e9e3d8]';

export default function PublicStore() {
  const [state, setState] = useState({ status: 'loading', bundle: null, error: null });
  // Bumped by the error screen's "Reintentar" — re-runs the fetch effect.
  const [attempt, setAttempt] = useState(0);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState({ key: 'availability', dir: 'asc' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', bundle: null, error: null });
    fetchStoreCatalog()
      .then((bundle) => { if (active) setState({ status: 'ready', bundle, error: null }); })
      .catch((e) => { if (active) setState({ status: 'error', bundle: null, error: userMessageFor(e) }); });
    return () => { active = false; };
  }, [attempt]);

  const bundle = state.bundle;

  const { items, resultCount, tabs, filterDefs, sortOptions } = useMemo(
    () => resolveStore({
      quotes: bundle?.quotes || [],
      lines: bundle?.lines || [],
      orders: bundle?.orders || [],
      inventory: bundle?.inventory || [],
      q, tab, filters, sort,
    }),
    [bundle, q, tab, filters, sort],
  );

  // Fold availability (a tab dimension in the VM) and family into ONE quiet
  // "Filtros" popover — the lookbook keeps its chrome minimal, no tab strip.
  const popoverFilters = useMemo(() => [
    {
      key: 'availability',
      label: 'Disponibilidad',
      type: 'select',
      placeholder: 'Todo',
      options: tabs.filter((t) => t.key !== 'all').map((t) => ({
        value: t.key,
        label: t.count ? `${t.label} · ${t.count}` : t.label,
      })),
    },
    ...filterDefs,
  ], [tabs, filterDefs]);
  const popoverActive = useMemo(
    () => ({ ...(tab !== 'all' ? { availability: tab } : {}), ...filters }),
    [tab, filters],
  );
  function onPopoverChange(next) {
    const { availability, ...rest } = next || {};
    setTab(availability || 'all');
    setFilters(rest);
  }

  useEffect(() => {
    if (!bundle) return undefined;
    const prev = document.title;
    document.title = bundle.storeName ? `Tienda · ${bundle.storeName}` : 'Tienda';
    return () => { document.title = prev; };
  }, [bundle]);

  if (state.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className={`h-full flex flex-col items-center justify-center gap-3 ${PAPER} text-ink-500`}>
        <Loader2 className="animate-spin text-ink-400" size={22} aria-hidden />
        <span className="text-sm text-ink-400">Cargando…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={`h-full flex flex-col items-center justify-center ${PAPER} text-center px-6`}>
        <div className={`inline-flex items-center justify-center w-16 h-16 rounded-full ${TILE} text-ink-400 mb-5`}>
          <AlertCircle size={28} strokeWidth={1.5} aria-hidden />
        </div>
        <div className="font-display text-xl text-ink-800">Tienda no disponible</div>
        <p className="text-sm text-ink-500 mt-2 max-w-sm leading-relaxed">
          No se pudo cargar la tienda en este momento. Inténtalo de nuevo en unos minutos.
        </p>
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-ink-300 px-4 py-2 text-xs font-medium text-ink-700 transition-colors hover:border-ink-900 hover:text-ink-900"
        >
          <RefreshCw size={14} aria-hidden /> Reintentar
        </button>
      </div>
    );
  }

  const storeName = bundle.storeName || 'Tienda';
  const totalProducts = tabs.find((t) => t.key === 'all')?.count || 0;
  const notReady = !bundle.configured || totalProducts === 0;
  // Public contact CTA — a WhatsApp (or tel:) deep-link built from the dealer's
  // public phone the `store` function returns. Absent number ⇒ no button.
  const contact = contactLinkFor(
    bundle.contactPhone,
    `Hola ${storeName}, vi su catálogo y quisiera más información.`,
  );

  return (
    <div className={`h-full overflow-y-auto overscroll-contain ${PAPER} text-ink-900`}>
      {/* Slim, centered wordmark bar. backdrop-blur reinforces depth as content scrolls under. */}
      <header
        className={`sticky top-0 z-20 border-b border-ink-200/50 backdrop-blur-sm ${PAPER_GLASS}`}
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="relative mx-auto flex h-14 max-w-7xl items-center justify-center px-4 sm:px-8">
          {bundle.logoImageId ? (
            <ImageView
              id={bundle.logoImageId}
              alt={storeName}
              className="h-7 max-w-[200px] object-contain"
              placeholderClassName="h-7 w-7"
            />
          ) : (
            <div className="font-wordmark text-xl tracking-wide text-ink-900">{storeName}</div>
          )}
          {contact && (
            <a
              href={contact.href}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute right-4 sm:right-8 inline-flex items-center gap-1.5 rounded-full border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:border-ink-900 hover:text-ink-900"
              aria-label={contact.kind === 'whatsapp' ? 'Escríbenos por WhatsApp' : 'Llámanos'}
            >
              {contact.kind === 'whatsapp'
                ? <MessageCircle size={14} aria-hidden />
                : <Phone size={14} aria-hidden />}
              <span className="hidden sm:inline">
                {contact.kind === 'whatsapp' ? 'WhatsApp' : 'Llamar'}
              </span>
            </a>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 sm:px-8 pb-[max(3.5rem,env(safe-area-inset-bottom))]">
        {notReady ? (
          <EmptyStore configured={bundle.configured} />
        ) : (
          <>
            {/* Collection header — eyebrow + large title + count, controls tucked right. */}
            <div className="flex flex-col gap-5 py-8 sm:flex-row sm:items-end sm:justify-between sm:py-12">
              <div className="min-w-0">
                <div className="eyebrow">Tienda</div>
                <h1 className="mt-2 font-display text-3xl font-normal leading-none tracking-tight sm:text-4xl">
                  Catálogo{' '}
                  <span className="align-middle text-2xl text-ink-300 sm:text-3xl">({resultCount})</span>
                </h1>
              </div>
              {/* Controls row: search grows to fill; filter + sort stay fixed-size.
                  On 320px the whole row is below the title (flex-col above sm:),
                  so `w-full` on the search ensures no clipping. */}
              <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto sm:flex-shrink-0">
                <div className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
                  <Search size={15} className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
                  <DebouncedInput
                    className="w-full rounded-none border-0 border-b border-ink-300 bg-transparent pl-6 pr-2 py-1.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-ink-900 focus:outline-none focus:ring-0"
                    type="search"
                    inputMode="search"
                    enterKeyHint="search"
                    autoComplete="off"
                    aria-label="Buscar"
                    value={q}
                    onCommit={setQ}
                    delay={250}
                    placeholder="Buscar"
                  />
                </div>
                <div className="flex-shrink-0">
                  <FilterPopover
                    filters={popoverFilters}
                    activeFilters={popoverActive}
                    onFiltersChange={onPopoverChange}
                  />
                </div>
                <div className="flex-shrink-0">
                  <SortMenu sortOptions={sortOptions} sort={sort} onSortChange={setSort} />
                </div>
              </div>
            </div>

            {items.length === 0 ? (
              <div className="py-24 text-center">
                <div className="font-display text-lg text-ink-800">Sin resultados</div>
                <p className="mt-1.5 text-sm text-ink-500">
                  Ningún artículo coincide con tu búsqueda o filtros.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 sm:gap-y-14 lg:grid-cols-3">
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
  // Show the availability line only for the states a shopper acts on; the
  // made-to-order default stays quiet to keep the lookbook clean.
  const showAvail = c.availability.bucket === 'available' || c.availability.bucket === 'incoming';
  return (
    <div className="group">
      <div className={`relative aspect-[4/5] overflow-hidden ${TILE}`}>
        <ImageView
          id={c.imageId}
          alt={c.name}
          className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          placeholderClassName="h-full w-full"
        />
      </div>
      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Full name, never clamped — product names are data. */}
          <h3 className="font-display text-sm font-medium leading-snug text-ink-900">{c.name}</h3>
          <div className="mt-1 text-sm text-ink-500 tabular-nums break-words">{priceLabel(c.price)}</div>
          {showAvail && (
            <div className="eyebrow-xs mt-1.5 text-ink-400 tracking-widest">{c.availability.label}</div>
          )}
        </div>
        {/* Fabric swatch as a small color dot — the material this piece is shown in. */}
        {c.swatchImageId && (
          <div className="mt-0.5 h-7 w-7 shrink-0 overflow-hidden rounded-full border border-ink-200 shadow-xs" title="Tela">
            <ImageView
              id={c.swatchImageId}
              alt=""
              className="h-full w-full object-cover"
              placeholderClassName="h-full w-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyStore({ configured }) {
  return (
    <div className="flex flex-col items-center justify-center py-36 text-center">
      <div className={`mb-5 inline-flex h-14 w-14 items-center justify-center rounded-full ${TILE} text-ink-500`}>
        <StoreIcon size={24} strokeWidth={1.5} />
      </div>
      <h3 className="font-display text-xl text-ink-800">Tienda en preparación</h3>
      <p className="mt-2.5 max-w-md text-sm text-ink-500 leading-relaxed">
        {configured
          ? 'Aún no hay productos publicados. Vuelve pronto.'
          : 'Estamos preparando nuestro catálogo. Vuelve pronto para ver la mercancía disponible y en camino.'}
      </p>
    </div>
  );
}
