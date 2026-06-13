import { userMessageFor } from '../../lib/errorMessages.js';
import { memo, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, ExternalLink, FileDown, Loader2, PackageSearch, RefreshCw, Shield } from 'lucide-react';
import ImageView from '../../components/ImageView.jsx';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { searchProducts, catalogCategories, productsByCategory, productsByBrand } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import { formatMoney } from '../../lib/format.js';
import { importLifestyleGardenCatalog } from '../../lib/shopifySync.js';
import { BRAND_LIFESTYLEGARDEN } from '../../lib/constants.js';
import { groupLsgModels, resolveLsgCatalogBook } from '../../core/catalog/index.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';

/**
 * Catálogo LifestyleGarden — the second brand catalog. Its particular import
 * manner is a one-click SYNC from the team's own Shopify store
 * (www.lifestylegarden.do): the shopify-sync Edge Function pulls every ACTIVE
 * product (what the public site shows) and upserts it into `products` with
 * brand 'lifestylegarden'; products that left the store are removed.
 *
 * Browse mirrors the Roset catalog page (category cards, lazy-loaded), but the
 * MODEL grouping differs by nature of the source: a model = one Shopify
 * PRODUCT (grouped by its handle in `familyCode`) and its members are the
 * store VARIANTS — there are no fabric grades here.
 */
export default function CatalogLifestyleGarden() {
  const { profileId, isAdmin } = useApp();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);
  const searching = dq.length > 0;

  // refresh ticks after a sync so the live queries refetch the new rows.
  const [refresh, setRefresh] = useState(0);
  const { data: categories, loaded: catsLoaded, error: catsError } = useLiveQueryStatus(
    () => (profileId ? catalogCategories(profileId, BRAND_LIFESTYLEGARDEN) : Promise.resolve([])),
    [profileId, refresh],
    [],
  );
  const total = useMemo(() => categories.reduce((n, c) => n + c.count, 0), [categories]);
  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => sortCat(a.category, b.category)),
    [categories],
  );

  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Catálogo LifestyleGarden" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar el catálogo de productos." />
      </>
    );
  }

  async function onSync() {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const r = await importLifestyleGardenCatalog();
      if (r?.configured === false) {
        setError('Shopify no está conectado. Conéctalo en Configuración → Shopify y vuelve a sincronizar.');
      } else if (r?.ok === false || r?.error) {
        setError(r?.error || 'No se pudo sincronizar el catálogo.');
      } else {
        const removed = Number(r?.removed) || 0;
        const images = Number(r?.images) || 0;
        setResult(`${r?.skus ?? 0} SKU de ${r?.products ?? 0} productos sincronizados${images ? ` · ${images} fotos enlazadas` : ''}${removed ? ` · ${removed} retirados` : ''}.`);
        setRefresh((n) => n + 1);
      }
    } catch (e) {
      console.error('[CatalogLifestyleGarden] sync failed:', e);
      setError(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }

  // The client-facing catalog PDF: only pieces in stock, grouped by
  // collection, shared through the same blob pipeline as the quote PDF
  // (Web Share on touch → WhatsApp, anchor download on desktop).
  async function onCatalogPdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    setError('');
    setResult('');
    try {
      const products = await productsByBrand(profileId, BRAND_LIFESTYLEGARDEN);
      const book = resolveLsgCatalogBook(products);
      if (!book.hasStockData) {
        setError('El catálogo aún no trae existencias. Sincroniza desde Shopify y vuelve a generar el PDF.');
        return;
      }
      if (!book.skus) {
        setError('No hay piezas en existencia para armar el catálogo.');
        return;
      }
      const mod = await safeDynamicImport(() => import('../../pdf/catalog/index.js'));
      const blob = await mod.generateLsgCatalogPdf({ book });
      await mod.downloadBlob(blob, 'Catálogo LifestyleGarden.pdf');
      setResult(`Catálogo listo: ${book.models} modelo(s) en existencia.`);
    } catch (e) {
      console.error('[CatalogLifestyleGarden] catalog pdf failed:', e);
      setError(userMessageFor(e));
    } finally {
      setPdfBusy(false);
    }
  }

  const emptyCatalog = !searching && catsLoaded && !catsError && total === 0;

  return (
    <>
      <PageHeader
        title="Catálogo LifestyleGarden"
        subtitle={total > 0 ? `${total} producto(s)` : ' '}
        actions={(
          <>
            <button
              type="button"
              onClick={onCatalogPdf}
              disabled={pdfBusy || total === 0}
              className="btn-secondary disabled:opacity-60"
              title="Catálogo PDF de piezas en existencia, para enviar por WhatsApp"
            >
              {pdfBusy ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
              Catálogo PDF
            </button>
            <button
              type="button"
              onClick={onSync}
              disabled={busy}
              className="btn-primary disabled:opacity-60"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Sincronizar desde Shopify
            </button>
          </>
        )}
      />

      {(result || error) && (
        <div role={error ? 'alert' : 'status'} className={`mb-4 rounded-lg px-3 py-2.5 text-xs flex items-center gap-2 shadow-xs ${
          error
            ? 'bg-red-50 border border-red-200 text-red-800'
            : 'bg-emerald-50 border border-emerald-200 text-emerald-800'
        }`}>
          {error ? <AlertTriangle size={14} className="flex-shrink-0" /> : <Check size={14} className="flex-shrink-0" />}
          {error || result}
        </div>
      )}

      {emptyCatalog ? (
        <EmptyState
          icon={PackageSearch}
          title="Catálogo vacío"
          description="Sincroniza la tienda Shopify de LifestyleGarden para tener su catálogo buscable al cotizar."
          action={<button type="button" onClick={onSync} disabled={busy} className="btn-primary"><RefreshCw size={14} /> Sincronizar desde Shopify</button>}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Buscar por referencia, nombre o colección…"
            resultCount={searching ? undefined : sortedCategories.length}
            resultNoun={['colección', 'colecciones']}
          />

          {searching ? (
            <SearchResults profileId={profileId} term={dq} />
          ) : !catsLoaded ? (
            <div className="card overflow-hidden"><ListLoading rows={6} /></div>
          ) : catsError ? (
            <EmptyState
              icon={PackageSearch}
              title="No se pudo cargar el catálogo"
              description="La columna de marca aún no existe en la base de datos (la migración todavía no se ha aplicado en este deploy). Espera a que termine el despliegue y recarga."
            />
          ) : (
            <div className="space-y-3">
              {sortedCategories.map((c) => (
                <CategoryCard
                  key={c.category || NONE_KEY}
                  profileId={profileId}
                  category={c.category}
                  count={c.count}
                  refresh={refresh}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });
const NO_CATEGORY = 'Sin colección';
const NONE_KEY = '__none__';
const SEARCH_LIMIT = 1000;

function sortCat(a, b) {
  if (!a && b) return 1;
  if (a && !b) return -1;
  return (a || '').localeCompare(b || '', 'es', { sensitivity: 'base' });
}

/** Stock across a model's variants: tracked when any member carries a figure
 *  (Shopify inventory, refreshed on sync), qty summed over the members. */
function modelStock(model) {
  const tracked = model.members.some((p) => p.stockQty != null);
  const qty = model.members.reduce((n, p) => n + (Number(p.stockQty) || 0), 0);
  return { tracked, qty };
}

/** "N en stock" / "agotado" tail for a single variant row; '' when untracked. */
function variantStockLabel(p) {
  if (p.stockQty == null) return '';
  const n = Number(p.stockQty) || 0;
  return n > 0 ? `${n} en stock` : 'agotado';
}

/** "$X" for one price, "$lo – $hi" across a model's variants. */
function priceRangeLabel(model) {
  const prices = model.members.map((p) => Number(p.priceUsd) || 0).filter((n) => n > 0);
  if (!prices.length) return '—';
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? usd(lo) : `${usd(lo)} – ${usd(hi)}`;
}

/** One CATEGORY (collection) card — collapsed; first open lazy-loads its rows. */
function CategoryCard({ profileId, category, count, refresh }) {
  const [everOpened, setEverOpened] = useState(false);
  const label = category || NO_CATEGORY;
  return (
    <details
      className="card overflow-clip group/cat"
      onToggle={(e) => { if (e.currentTarget.open) setEverOpened(true); }}
    >
      <summary className="card-header cursor-pointer list-none select-none transition-colors hover:bg-ink-50 active:bg-ink-100">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight
            size={15}
            className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90"
            aria-hidden
          />
          <span className="font-display font-semibold text-sm text-ink-900 truncate" title={label}>{label}</span>
        </span>
        <span className="eyebrow-xs flex-shrink-0">{count} SKU</span>
      </summary>
      {everOpened && <CategoryModels profileId={profileId} category={category} refresh={refresh} />}
    </details>
  );
}

function CategoryModels({ profileId, category, refresh }) {
  const { data: products, loaded, error } = useLiveQueryStatus(
    () => productsByCategory(profileId, category, BRAND_LIFESTYLEGARDEN),
    [profileId, category, refresh],
    [],
  );
  const models = useMemo(() => groupLsgModels(products), [products]);

  if (!loaded) {
    return (
      <div className="px-5 py-6 text-center text-sm text-ink-500 flex items-center justify-center gap-2">
        <Loader2 size={15} className="animate-spin" /> Cargando…
      </div>
    );
  }
  if (error) {
    return <div className="px-5 py-4 text-sm text-red-700">No se pudieron cargar los productos.</div>;
  }
  if (models.length === 0) {
    return <div className="px-5 py-4 text-sm text-ink-500">Sin productos en esta colección.</div>;
  }
  return <ModelList models={models} />;
}

function SearchResults({ profileId, term }) {
  const { data: rows, loaded } = useLiveQueryStatus(
    () => searchProducts(profileId, term, SEARCH_LIMIT, BRAND_LIFESTYLEGARDEN),
    [profileId, term],
    [],
  );
  const sections = useMemo(() => {
    const byCategory = new Map();
    for (const p of rows || []) {
      const key = (p.category || '').trim();
      const bucket = byCategory.get(key);
      if (bucket) bucket.push(p);
      else byCategory.set(key, [p]);
    }
    return [...byCategory.entries()]
      .map(([category, items]) => ({ category, count: items.length, models: groupLsgModels(items) }))
      .sort((a, b) => sortCat(a.category, b.category));
  }, [rows]);

  if (!loaded) {
    return <div className="card overflow-hidden"><ListLoading rows={6} /></div>;
  }
  if (sections.length === 0) {
    return <div className="card px-4 py-10 text-center text-sm text-ink-400">Sin coincidencias para esa búsqueda.</div>;
  }
  return (
    <>
      <p className="mb-3 text-xs text-ink-500" aria-live="polite">
        {rows.length === 1 ? '1 producto' : `${rows.length} productos`}
      </p>
      <div className="space-y-3">
        {sections.map((s) => (
          <details open key={s.category || NONE_KEY} className="card overflow-hidden group/cat">
            <summary className="card-header cursor-pointer list-none select-none transition-colors hover:bg-ink-50 active:bg-ink-100">
              <span className="flex items-center gap-2 min-w-0">
                <ChevronRight
                  size={15}
                  className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90"
                  aria-hidden
                />
                <span className="font-display font-semibold text-sm text-ink-900 truncate" title={s.category || NO_CATEGORY}>
                  {s.category || NO_CATEGORY}
                </span>
              </span>
              <span className="eyebrow-xs flex-shrink-0">{s.models.length} modelo(s) · {s.count} SKU</span>
            </summary>
            <ModelList models={s.models} />
          </details>
        ))}
      </div>
      {rows.length >= SEARCH_LIMIT && (
        <div className="px-4 py-2 text-[11px] text-ink-500">
          Mostrando los primeros {SEARCH_LIMIT}. Afina la búsqueda para ver más.
        </div>
      )}
    </>
  );
}

/** The card grid a category (or search section) renders its models in. */
function ModelList({ models }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 p-3 sm:p-4">
      {models.map((m) => (
        <ModelCard key={m.key} model={m} />
      ))}
    </div>
  );
}

/**
 * One MODEL (Shopify product) as a CARD: the store photo, the full identity
 * (name, range, references, variant axis), the price (range across variants)
 * and the wholesale cost when Shopify carries one — plus the product's own
 * page on lifestylegarden.do. Multi-variant models expand their SKU list in
 * place.
 */
const ModelCard = memo(function ModelCard({ model }) {
  const lead = model.members[0] || {};
  const single = model.members.length === 1;
  const storeUrl = lead.familyCode ? `https://www.lifestylegarden.do/products/${lead.familyCode}` : null;
  const stock = modelStock(model);
  return (
    <div className="rounded-lg border border-ink-100 bg-surface overflow-hidden flex flex-col shadow-xs [content-visibility:auto] [contain-intrinsic-size:auto_280px]">
      <ImageView
        id={lead.imageId}
        fallbackUrl={lead.imageSrc || null}
        alt={model.name}
        hoverPreview
        className="w-full aspect-[4/3] object-cover bg-ink-50"
        placeholderClassName="w-full aspect-[4/3] bg-ink-50"
      />
      <div className="p-3 flex flex-col gap-1 flex-1 min-w-0">
        {lead.family && <span className="eyebrow-xs truncate">{lead.family}</span>}
        <span className="text-sm font-medium text-ink-900 leading-snug line-clamp-2" title={model.name}>{model.name}</span>
        {single ? (
          <span className="font-mono text-[11px] text-ink-500 truncate" title={lead.reference}>{lead.reference}</span>
        ) : (
          <span className="text-[11px] text-ink-500">{model.members.length} variantes</span>
        )}
        {/* Live store inventory (Shopify, refreshed on sync) — what gates the
            quote builder and the client catalog PDF. */}
        {stock.tracked && (
          <span className="mt-0.5">
            {stock.qty > 0
              ? <span className="chip bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums">{stock.qty} en stock</span>
              : <span className="chip bg-red-50 text-red-700 border border-red-200">Agotado</span>}
          </span>
        )}
        <div className="mt-auto pt-1 flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold tabular-nums text-ink-900 whitespace-nowrap">{priceRangeLabel(model)}</span>
          {lead.cost != null && single && (
            <span className="text-[11px] tabular-nums text-ink-400 whitespace-nowrap" title="Costo mayorista (Shopify)">
              costo {usd(lead.cost)}
            </span>
          )}
        </div>
        {!single && (
          <details className="group/vars -mx-1">
            <summary className="cursor-pointer list-none select-none px-1 py-1 text-[11px] font-medium text-ink-600 hover:text-ink-900 inline-flex items-center gap-1 transition-colors">
              <ChevronRight size={11} className="transition-transform group-open/vars:rotate-90" aria-hidden />
              Ver variantes
            </summary>
            <ul className="divide-y divide-ink-100/70 px-1 pb-1">
              {model.members.map((p) => (
                <li key={p.id} className="py-1.5 text-[11px] min-w-0">
                  <div className="flex items-baseline justify-between gap-2 min-w-0">
                    <span className="text-ink-700 truncate" title={p.subtype || p.reference}>{p.subtype || '—'}</span>
                    <span className="tabular-nums font-medium text-ink-900 whitespace-nowrap">{usd(p.priceUsd)}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 min-w-0">
                    <span className="font-mono text-ink-400 truncate" title={p.reference}>{p.reference}</span>
                    <span className="flex items-baseline gap-2 whitespace-nowrap">
                      {variantStockLabel(p) && (
                        <span className={`tabular-nums ${Number(p.stockQty) > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {variantStockLabel(p)}
                        </span>
                      )}
                      {p.cost != null && (
                        <span className="tabular-nums text-ink-400" title="Costo mayorista (Shopify)">costo {usd(p.cost)}</span>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
        {storeUrl && (
          <a
            href={storeUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-brand-700 hover:text-brand-900 hover:underline inline-flex items-center gap-1 transition-colors"
          >
            <ExternalLink size={11} aria-hidden /> Ver en lifestylegarden.do
          </a>
        )}
      </div>
    </div>
  );
});
