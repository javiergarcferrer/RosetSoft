import { userMessageFor } from '../../lib/errorMessages.js';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { PackageSearch, Shield, Upload, Loader2, Check, ChevronRight, AlertTriangle } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, searchProducts, catalogCategories, productsByCategory } from '../../db/database.js';
import { BRAND_LIGNE_ROSET } from '../../lib/constants.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import CatalogFilterBar, { DEFAULT_CATALOG_FILTERS } from '../../components/catalog/CatalogFilterBar.jsx';
import { formatMoney } from '../../lib/format.js';
import { parsePriceList, dedupeBySku, unifySplitNames } from '../../lib/priceListCsv.js';
import { groupFamilies } from '../../lib/catalog.js';

/**
 * Catálogo — the Ligne Roset product catalog, imported from the supplier
 * price-list CSV. Admin-only to manage (same gate as the other /admin pages);
 * RLS lets any team member read so the quote builder's product picker works.
 *
 * The catalog is tens of thousands of SKUs, so the view never pulls the whole
 * table. Two modes:
 *   • Browse — list every CATEGORY up-front (one cheap server-side aggregate),
 *     collapsed. Opening a category lazy-loads ITS products and groups them
 *     into MODELS (groupFamilies collapses each 8-digit SKU root + its grade
 *     variants). Each model is itself collapsible: collapsed it shows just its
 *     name + price range; expanded it lists the grade-variant SKUs.
 *   • Search — a bounded server-side match, grouped into the same
 *     category → model shape so a query reads the same way as browsing.
 *
 * Import is a CSV upload (thousands of SKUs, refreshed periodically): parsed
 * client-side (lib/priceListCsv) and upserted into `products`, keyed by SKU so
 * re-uploading replaces prices in place.
 */
export default function Catalog() {
  const { profileId, isAdmin } = useApp();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  // Debounce so each keystroke isn't its own query.
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);
  const searching = dq.length > 0;

  // Browse: every category up-front (one cheap aggregate), each lazy-loaded on
  // open. Loaded regardless of search so toggling search ↔ browse is instant.
  // Brand-scoped: this page is the Ligne Roset catalog; other brands live on
  // their own pages under the Catálogos section.
  const { data: categories, loaded: catsLoaded, error: catsError } = useLiveQueryStatus(
    () => (profileId ? catalogCategories(profileId, BRAND_LIGNE_ROSET) : Promise.resolve([])),
    [profileId],
    [],
  );
  // Header total = the brand's SKUs, summed from the category aggregate (no
  // extra count round-trip, and it can't leak other brands' rows).
  const total = useMemo(() => categories.reduce((n, c) => n + c.count, 0), [categories]);

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => sortCat(a.category, b.category)),
    [categories],
  );

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Catálogo Roset" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar el catálogo de productos." />
      </>
    );
  }

  async function onFile(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    setResult('');
    try {
      const text = await file.text();
      // dedupeBySku collapses the list's repeated SKUs (required: a single
      // upsert batch can't touch the same primary key twice) and resolves
      // stale-price duplicates to the canonical current price. unifySplitNames
      // then heals accessory SKUs whose grade rows carry different parent-model
      // names, so each stays one searchable model (e.g. PRADO "S/2 BOLSTERS").
      const parsed = unifySplitNames(dedupeBySku(parsePriceList(text)));
      if (parsed.length === 0) {
        setError('No se reconocieron productos. ¿Es el CSV de la lista de precios de Roset?');
        return;
      }
      // Omit created_at: the upsert leaves it unchanged on existing rows and
      // the column default fills it for new ones — so we never read the table.
      const upserts = parsed.map((p) => ({
        id: p.reference,
        profileId,
        brand: BRAND_LIGNE_ROSET,
        reference: p.reference,
        name: p.name,
        subtype: p.subtype,
        dimensions: p.dimensions,
        family: p.family,
        familyCode: p.familyCode,
        category: p.category,
        priceUsd: p.priceUsd,
        cost: p.cost,
        active: true,
      }));
      await db.products.bulkPut(upserts);
      setResult(`${upserts.length} productos importados.`);
    } catch (e) {
      console.error('[Catalog] import failed:', e);
      setError(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }

  // Truly-empty catalog (no products at all, not just an unmatched search):
  // show the import call-to-action instead of an empty category list.
  const emptyCatalog = !searching && catsLoaded && !catsError && total === 0 && sortedCategories.length === 0;

  return (
    <>
      <PageHeader
        title="Catálogo Roset"
        subtitle={total > 0 ? `${total} producto(s)` : ' '}
        actions={(
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="btn-primary disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Importar CSV
          </button>
        )}
      />

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
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
          description="Importa la lista de precios de Roset (CSV) para tener un catálogo buscable al cotizar."
          action={<button type="button" onClick={() => inputRef.current?.click()} className="btn-primary"><Upload size={14} /> Importar CSV</button>}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Buscar por referencia, nombre o familia…"
            resultCount={searching ? undefined : sortedCategories.length}
            resultNoun={['categoría', 'categorías']}
          />

          {searching ? (
            <SearchResults profileId={profileId} term={dq} />
          ) : !catsLoaded ? (
            <div className="card overflow-hidden"><ListLoading rows={6} /></div>
          ) : catsError ? (
            <EmptyState
              icon={PackageSearch}
              title="No se pudo cargar el catálogo"
              description="La tabla de productos aún no existe en la base de datos (la migración todavía no se ha aplicado en este deploy). Espera a que termine el despliegue y recarga; el catálogo aparecerá en cuanto la migración corra."
            />
          ) : (
            <div className="space-y-3">
              {sortedCategories.map((c) => (
                <CategoryCard
                  key={c.category || NONE_KEY}
                  profileId={profileId}
                  category={c.category}
                  count={c.count}
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
const NO_CATEGORY = 'Sin categoría';
const NONE_KEY = '__none__';
const SEARCH_LIMIT = 1000;

/** Sort categories A→Z, sinking the empty ("Sin categoría") bucket to the end. */
function sortCat(a, b) {
  if (!a && b) return 1;
  if (a && !b) return -1;
  return (a || '').localeCompare(b || '', 'es', { sensitivity: 'base' });
}

/**
 * Group a flat product list (a search result set) into CATEGORY → MODEL — the
 * same shape the browse view renders, so a query reads identically. Sections
 * and models are sorted A→Z.
 */
function groupByCategory(rows) {
  const byCategory = new Map();
  for (const p of rows || []) {
    const key = (p.category || '').trim();
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(p);
    else byCategory.set(key, [p]);
  }
  const sections = [];
  for (const [category, items] of byCategory) {
    sections.push({ category, count: items.length, models: toModels(items) });
  }
  return sections.sort((a, b) => sortCat(a.category, b.category));
}

/** Collapse a category's products into models, sorted by display name. */
function toModels(products) {
  return groupFamilies(products).sort((a, b) =>
    (a.name || a.root).localeCompare(b.name || b.root, 'es', { sensitivity: 'base' }),
  );
}

/** A model's member SKUs: graded variants first (ascending price), then any
 *  lone ungraded SKU. */
function memberSkus(model) {
  return [
    ...model.grades.map((g) => ({ grade: g, product: model.byGrade.get(g) })),
    ...(model.byGrade.has('') ? [{ grade: '', product: model.byGrade.get('') }] : []),
  ].filter((m) => m.product);
}

/** A model's price span across its grade variants — `{ lo, hi }`, or null when
 *  no variant carries a positive price. Drives the row label, the price-range
 *  filter and the price sorts. */
function modelPriceBounds(model) {
  let lo = Infinity;
  let hi = 0;
  for (const p of model.byGrade.values()) {
    const n = Number(p?.priceUsd) || 0;
    if (n > 0) {
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
  }
  return hi > 0 ? { lo, hi } : null;
}

/** "$X" when every variant is one price, else "$lo – $hi" across the model's
 *  grade variants — the at-a-glance figure shown on the collapsed model row. */
function priceRangeLabel(model) {
  const b = modelPriceBounds(model);
  if (!b) return '—';
  return b.lo === b.hi ? usd(b.lo) : `${usd(b.lo)} – ${usd(b.hi)}`;
}

/**
 * Apply the filter bar's narrowing filters to a model list (pure; no sort).
 * Text matches the model name, family, root and member SKU references; the
 * Min/Max USD window keeps a model whose price RANGE overlaps it (a model
 * priced $900–$1,400 matches "max $1,000"). Unpriced models drop out only
 * when a price bound is set.
 */
function filterModels(models, filters) {
  const text = (filters.text || '').trim().toLowerCase();
  const min = filters.min === '' ? null : Number(filters.min) || 0;
  const max = filters.max === '' ? null : Number(filters.max) || 0;
  if (!text && min == null && max == null) return models;
  return models.filter((m) => {
    if (text) {
      let hay = `${m.name || ''} ${m.family || ''} ${m.root || ''}`.toLowerCase();
      for (const p of m.byGrade.values()) hay += ` ${(p.reference || '').toLowerCase()}`;
      if (!hay.includes(text)) return false;
    }
    if (min != null || max != null) {
      const b = modelPriceBounds(m);
      if (!b) return false;
      if (min != null && b.hi < min) return false;
      if (max != null && b.lo > max) return false;
    }
    return true;
  });
}

/**
 * Order a model list per the filter bar's sort (pure; returns a new array
 * except for the default). 'name' is the order `toModels` already produced;
 * price sorts key on the range's cheap end (↑) / expensive end (↓), sinking
 * unpriced models to the bottom either way; 'skus' = most variants first.
 */
function sortModels(models, sort) {
  if (sort === 'name' || !sort) return models;
  const arr = [...models];
  if (sort === 'priceAsc' || sort === 'priceDesc') {
    const asc = sort === 'priceAsc';
    arr.sort((a, b) => {
      const A = modelPriceBounds(a);
      const B = modelPriceBounds(b);
      if (!A || !B) return (A ? 0 : 1) - (B ? 0 : 1);
      return asc ? A.lo - B.lo || A.hi - B.hi : B.hi - A.hi || B.lo - A.lo;
    });
  } else if (sort === 'skus') {
    arr.sort((a, b) => b.byGrade.size - a.byGrade.size);
  }
  return arr;
}

// Incremental rendering — a huge category (Asientos ≈ hundreds of models,
// thousands of SKUs) must never mount every row at once. Lists render the
// first batch and grow on "Mostrar más"; the limit resets the moment the
// underlying list changes (new category / filter / sort), synchronously
// during render so a stale larger limit never paints.
const MODEL_BATCH = 40;
const SKU_BATCH = 60;

function useBatch(items, batch) {
  const [state, setState] = useState({ items, limit: batch });
  if (state.items !== items) setState({ items, limit: batch });
  const limit = state.items === items ? state.limit : batch;
  const visible = useMemo(
    () => (items.length > limit ? items.slice(0, limit) : items),
    [items, limit],
  );
  const remaining = Math.max(0, items.length - limit);
  const showMore = () => setState((s) => ({ ...s, limit: s.limit + batch }));
  return { visible, remaining, showMore };
}

/** The "Mostrar más (N restantes)" reveal control under a truncated list. */
function ShowMoreButton({ remaining, onClick, className = '' }) {
  return (
    <div className={`py-2.5 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        className="btn-secondary w-full justify-center text-xs"
      >
        Mostrar más ({remaining} {remaining === 1 ? 'restante' : 'restantes'})
      </button>
    </div>
  );
}

/**
 * One CATEGORY card in browse mode. Collapsed by default; opening it
 * lazy-loads (and then keeps) the category's products. `onToggle` flips
 * `everOpened` on first open so the body fetch fires exactly once.
 */
function CategoryCard({ profileId, category, count }) {
  const [everOpened, setEverOpened] = useState(false);
  const label = category || NO_CATEGORY;
  return (
    // overflow-clip (not -hidden): same rounded-corner clipping, but it keeps
    // the body's sticky filter bar working — overflow:hidden would make the
    // card the sticky containing scrollport and the bar would never pin.
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
      {everOpened && <CategoryModels profileId={profileId} category={category} />}
    </details>
  );
}

/** Lazy body of a category card — fetches the category's products on mount,
 *  groups them into models and renders them behind the refine toolbar. */
function CategoryModels({ profileId, category }) {
  const { data: products, loaded, error } = useLiveQueryStatus(
    () => productsByCategory(profileId, category, BRAND_LIGNE_ROSET),
    [profileId, category],
    [],
  );
  const allModels = useMemo(() => toModels(products), [products]);
  const [filters, setFilters] = useState(DEFAULT_CATALOG_FILTERS);
  const models = useMemo(
    () => sortModels(filterModels(allModels, filters), filters.sort),
    [allModels, filters],
  );

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
  if (allModels.length === 0) {
    return <div className="px-5 py-4 text-sm text-ink-500">Sin productos en esta categoría.</div>;
  }
  return (
    <>
      {allModels.length > 1 && (
        <CatalogFilterBar
          value={filters}
          onChange={setFilters}
          shown={models.length}
          total={allModels.length}
        />
      )}
      {models.length === 0 ? (
        <FilteredOutNotice onClear={() => setFilters({ ...DEFAULT_CATALOG_FILTERS, sort: filters.sort })} />
      ) : (
        <ModelList models={models} />
      )}
    </>
  );
}

/** Empty state when the category HAS models but the bar's filters hide all. */
function FilteredOutNotice({ onClear }) {
  return (
    <div className="px-5 py-6 text-center text-sm text-ink-500">
      Ningún modelo coincide con los filtros.{' '}
      <button type="button" className="inline-flex items-center rounded-md px-1.5 min-h-8 coarse:min-h-11 font-medium text-brand-700 hover:underline hover:bg-brand-50 transition-colors" onClick={onClear}>
        Limpiar filtros
      </button>
    </div>
  );
}

/**
 * Search results — owns its own query so a fresh search shows a real loader and
 * the previous matches stay on screen (SWR-style) while a new term settles,
 * instead of flashing a false "no matches". Renders the same category → model
 * shape as the browse view, open by default.
 */
function SearchResults({ profileId, term }) {
  const { data: rows, loaded } = useLiveQueryStatus(
    () => searchProducts(profileId, term, SEARCH_LIMIT, BRAND_LIGNE_ROSET),
    [profileId, term],
    [],
  );
  const allSections = useMemo(() => groupByCategory(rows), [rows]);

  // The refine bar narrows the (already-fetched) matches client-side, across
  // every category section; empty sections drop out.
  const [filters, setFilters] = useState(DEFAULT_CATALOG_FILTERS);
  const { sections, shown, total } = useMemo(() => {
    let shownN = 0;
    let totalN = 0;
    const out = [];
    for (const s of allSections) {
      totalN += s.models.length;
      const models = sortModels(filterModels(s.models, filters), filters.sort);
      shownN += models.length;
      if (models.length > 0) {
        // Re-count SKUs over the surviving models so the section header
        // ("N modelo(s) · M SKU") stays truthful under active filters.
        const count = models.reduce((n, m) => n + m.byGrade.size, 0);
        out.push({ ...s, models, count });
      }
    }
    return { sections: out, shown: shownN, total: totalN };
  }, [allSections, filters]);

  if (!loaded) {
    return <div className="card overflow-hidden"><ListLoading rows={6} /></div>;
  }
  if (allSections.length === 0) {
    return <div className="card px-4 py-10 text-center text-sm text-ink-400">Sin coincidencias para esa búsqueda.</div>;
  }
  return (
    <>
      <p className="mb-3 text-xs text-ink-500" aria-live="polite">
        {rows.length === 1 ? '1 producto' : `${rows.length} productos`}
      </p>
      {total > 1 && (
        <div className="card overflow-clip mb-3">
          <CatalogFilterBar
            value={filters}
            onChange={setFilters}
            shown={shown}
            total={total}
            placeholder="Filtrar resultados…"
          />
        </div>
      )}
      {sections.length === 0 ? (
        <div className="card">
          <FilteredOutNotice onClear={() => setFilters({ ...DEFAULT_CATALOG_FILTERS, sort: filters.sort })} />
        </div>
      ) : (
        <div className="space-y-3">
          {sections.map((section) => (
            <CategorySection key={section.category || NONE_KEY} section={section} />
          ))}
        </div>
      )}
      {rows.length >= SEARCH_LIMIT && (
        <div className="px-4 py-2 text-[11px] text-ink-500">
          Mostrando los primeros {SEARCH_LIMIT}. Afina la búsqueda para ver más.
        </div>
      )}
    </>
  );
}

/**
 * One CATEGORY section in search mode. Same chrome as the browse card but
 * open by default (the products are already loaded with the search) so hits
 * are visible immediately.
 */
function CategorySection({ section }) {
  return (
    <details open className="card overflow-hidden group/cat">
      <summary className="card-header cursor-pointer list-none select-none transition-colors hover:bg-ink-50 active:bg-ink-100">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight
            size={15}
            className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90"
            aria-hidden
          />
          <span className="font-display font-semibold text-sm text-ink-900 truncate" title={section.category || NO_CATEGORY}>
            {section.category || NO_CATEGORY}
          </span>
        </span>
        <span className="eyebrow-xs flex-shrink-0">
          {section.models.length} modelo(s) · {section.count} SKU
        </span>
      </summary>
      <ModelList models={section.models} />
    </details>
  );
}

/** The list of model rows inside a category — renders the first MODEL_BATCH
 *  and grows on "Mostrar más"; the cursor resets whenever `models` changes
 *  (new category / filter / sort). */
function ModelList({ models }) {
  const { visible, remaining, showMore } = useBatch(models, MODEL_BATCH);
  return (
    <div className="divide-y divide-ink-100">
      {visible.map((model) => (
        <ModelRow key={model.root} model={model} />
      ))}
      {remaining > 0 && (
        <ShowMoreButton remaining={remaining} onClick={showMore} className="px-4 sm:px-5" />
      )}
    </div>
  );
}

/**
 * One MODEL row — collapsed by default. The summary shows the model name and
 * its price range (everything the dealer needs at a glance); expanding reveals
 * the grade-variant SKUs with their reference, finish, price, cost and margin.
 *
 * Memoized (the `model` object is referentially stable across re-renders) and
 * marked content-visibility:auto with an intrinsic height hint, so off-screen
 * rows in a long category skip layout/paint entirely.
 */
const ModelRow = memo(function ModelRow({ model }) {
  const members = useMemo(() => memberSkus(model), [model]);
  const { visible, remaining, showMore } = useBatch(members, SKU_BATCH);
  return (
    <details className="group/model [content-visibility:auto] [contain-intrinsic-size:auto_42px]">
      <summary className="cursor-pointer list-none select-none pl-6 sm:pl-8 pr-3 sm:pr-5 py-2.5 coarse:py-3 flex items-center justify-between gap-2 hover:bg-ink-50 active:bg-ink-100 transition-colors min-w-0">
        <span className="flex items-center gap-2 min-w-0 flex-1">
          <ChevronRight
            size={13}
            className="text-ink-400 flex-shrink-0 transition-transform duration-150 group-open/model:rotate-90"
            aria-hidden
          />
          <span className="font-medium text-sm text-ink-800 truncate" title={model.name || model.root}>
            {model.name || model.root || '—'}
          </span>
          <span className="eyebrow-xs flex-shrink-0 hidden sm:inline">
            {members.length} {members.length === 1 ? 'SKU' : 'SKUs'}
          </span>
        </span>
        <span className="text-sm tabular-nums font-medium text-ink-700 whitespace-nowrap flex-shrink-0">
          {priceRangeLabel(model)}
        </span>
      </summary>
      <ul className="divide-y divide-ink-100/60 bg-ink-50/40 pl-8 sm:pl-10 pr-3 sm:pr-4 pb-1.5">
        {visible.map(({ grade, product: p }) => (
          <SkuRow key={p.id} grade={grade} product={p} />
        ))}
        {remaining > 0 && (
          <li className="list-none">
            <ShowMoreButton remaining={remaining} onClick={showMore} />
          </li>
        )}
      </ul>
    </details>
  );
});

/** One grade-variant SKU line inside an expanded model. Memoized: `grade` is a
 *  string and `product` a stable row object, so re-renders skip untouched SKUs. */
const SkuRow = memo(function SkuRow({ grade, product: p }) {
  const price = Number(p.priceUsd) || 0;
  const cost = Number(p.cost) || 0;
  const marginPct = price > 0 ? Math.round(((price - cost) / price) * 100) : 0;
  return (
    <li className="flex items-center gap-2 py-1.5 text-sm hover:bg-ink-100/40 rounded transition-colors -mx-1 px-1 min-w-0">
      {grade ? (
        <span className="chip bg-brand-50 text-brand-700 border border-brand-100 flex-shrink-0">{grade}</span>
      ) : (
        <span className="chip text-ink-400 border border-dashed border-ink-200 flex-shrink-0">—</span>
      )}
      <span className="font-mono text-xs text-ink-500 flex-shrink-0 w-20 min-[400px]:w-24 truncate" title={p.reference}>
        {p.reference}
      </span>
      <span className="text-ink-500 text-xs truncate flex-1 min-w-0 hidden min-[400px]:inline" title={p.subtype || p.name}>
        {p.subtype || ''}
      </span>
      <span className="tabular-nums text-right flex-shrink-0 font-medium text-ink-800 ml-auto">{usd(price)}</span>
      <span className="tabular-nums text-right text-ink-400 w-20 flex-shrink-0 hidden sm:inline">{usd(cost)}</span>
      <span className="tabular-nums text-right text-ink-400 w-10 flex-shrink-0 hidden lg:inline">{marginPct}%</span>
    </li>
  );
});
