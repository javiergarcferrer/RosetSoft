import { useEffect, useMemo, useRef, useState } from 'react';
import { PackageSearch, Shield, Upload, Loader2, Check, ChevronRight } from 'lucide-react';
import { useLiveQuery, useLiveQueryStatus } from '../../db/hooks.js';
import { db, searchProducts, catalogCategories, productsByCategory } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import { formatMoney } from '../../lib/format.js';
import { parsePriceList, dedupeBySku } from '../../lib/priceListCsv.js';
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
  const { data: categories, loaded: catsLoaded, error: catsError } = useLiveQueryStatus(
    () => (profileId ? catalogCategories(profileId) : Promise.resolve([])),
    [profileId],
    [],
  );
  // Cheap HEAD count for the header total (not a full fetch).
  const total = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).count() : Promise.resolve(0)),
    [profileId],
    0,
  );

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
        <PageHeader title="Catálogo" subtitle=" " />
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
      // stale-price duplicates to the canonical current price.
      const parsed = dedupeBySku(parsePriceList(text));
      if (parsed.length === 0) {
        setError('No se reconocieron productos. ¿Es el CSV de la lista de precios de Roset?');
        return;
      }
      // Omit created_at: the upsert leaves it unchanged on existing rows and
      // the column default fills it for new ones — so we never read the table.
      const upserts = parsed.map((p) => ({
        id: p.reference,
        profileId,
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
      setError(e?.message || 'No se pudo importar el archivo.');
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
        title="Catálogo"
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
        <div className={`mb-4 rounded-md px-3 py-2 text-xs flex items-center gap-2 ${
          error ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-green-50 border border-green-200 text-green-800'
        }`}>
          {error ? null : <Check size={14} />}
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

/** "$X" when every variant is one price, else "$lo – $hi" across the model's
 *  grade variants — the at-a-glance figure shown on the collapsed model row. */
function priceRangeLabel(model) {
  const prices = [...model.byGrade.values()]
    .map((p) => Number(p?.priceUsd) || 0)
    .filter((n) => n > 0);
  if (!prices.length) return '—';
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? usd(lo) : `${usd(lo)} – ${usd(hi)}`;
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
    <details
      className="card overflow-hidden group/cat"
      onToggle={(e) => { if (e.currentTarget.open) setEverOpened(true); }}
    >
      <summary className="card-header cursor-pointer list-none select-none hover:bg-ink-50">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight
            size={15}
            className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90"
            aria-hidden
          />
          <span className="font-semibold text-sm text-ink-900 truncate" title={label}>{label}</span>
        </span>
        <span className="eyebrow-xs tracking-wide flex-shrink-0">{count} SKU</span>
      </summary>
      {everOpened && <CategoryModels profileId={profileId} category={category} />}
    </details>
  );
}

/** Lazy body of a category card — fetches the category's products on mount and
 *  renders its models. */
function CategoryModels({ profileId, category }) {
  const { data: products, loaded, error } = useLiveQueryStatus(
    () => productsByCategory(profileId, category),
    [profileId, category],
    [],
  );
  const models = useMemo(() => toModels(products), [products]);

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
    return <div className="px-5 py-4 text-sm text-ink-500">Sin productos en esta categoría.</div>;
  }
  return <ModelList models={models} />;
}

/**
 * Search results — owns its own query so a fresh search shows a real loader and
 * the previous matches stay on screen (SWR-style) while a new term settles,
 * instead of flashing a false "no matches". Renders the same category → model
 * shape as the browse view, open by default.
 */
function SearchResults({ profileId, term }) {
  const { data: rows, loaded } = useLiveQueryStatus(
    () => searchProducts(profileId, term, SEARCH_LIMIT),
    [profileId, term],
    [],
  );
  const sections = useMemo(() => groupByCategory(rows), [rows]);

  if (!loaded) {
    return <div className="card overflow-hidden"><ListLoading rows={6} /></div>;
  }
  if (sections.length === 0) {
    return <div className="card px-4 py-8 text-center text-sm text-ink-500">Sin coincidencias.</div>;
  }
  return (
    <>
      <p className="mb-3 text-xs text-ink-500" aria-live="polite">
        {rows.length === 1 ? '1 producto' : `${rows.length} productos`}
      </p>
      <div className="space-y-3">
        {sections.map((section) => (
          <CategorySection key={section.category || NONE_KEY} section={section} />
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

/**
 * One CATEGORY section in search mode. Same chrome as the browse card but
 * open by default (the products are already loaded with the search) so hits
 * are visible immediately.
 */
function CategorySection({ section }) {
  return (
    <details open className="card overflow-hidden group/cat">
      <summary className="card-header cursor-pointer list-none select-none hover:bg-ink-50">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight
            size={15}
            className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90"
            aria-hidden
          />
          <span className="font-semibold text-sm text-ink-900 truncate" title={section.category || NO_CATEGORY}>
            {section.category || NO_CATEGORY}
          </span>
        </span>
        <span className="eyebrow-xs tracking-wide flex-shrink-0">
          {section.models.length} modelo(s) · {section.count} SKU
        </span>
      </summary>
      <ModelList models={section.models} />
    </details>
  );
}

/** The list of model rows inside a category. */
function ModelList({ models }) {
  return (
    <div className="divide-y divide-ink-100">
      {models.map((model) => (
        <ModelRow key={model.root} model={model} />
      ))}
    </div>
  );
}

/**
 * One MODEL row — collapsed by default. The summary shows the model name and
 * its price range (everything the dealer needs at a glance); expanding reveals
 * the grade-variant SKUs with their reference, finish, price, cost and margin.
 */
function ModelRow({ model }) {
  const members = memberSkus(model);
  return (
    <details className="group/model">
      <summary className="cursor-pointer list-none select-none pl-8 pr-5 py-2.5 flex items-center justify-between gap-3 hover:bg-ink-50">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight
            size={13}
            className="text-ink-400 flex-shrink-0 transition-transform group-open/model:rotate-90"
            aria-hidden
          />
          <span className="font-medium text-sm text-ink-800 truncate" title={model.name || model.root}>
            {model.name || model.root || '—'}
          </span>
          <span className="eyebrow-xs tracking-wide flex-shrink-0 hidden sm:inline">
            {members.length} {members.length === 1 ? 'SKU' : 'SKUs'}
          </span>
        </span>
        <span className="text-sm tabular-nums text-ink-700 whitespace-nowrap flex-shrink-0">
          {priceRangeLabel(model)}
        </span>
      </summary>
      <ul className="divide-y divide-ink-100/70 bg-ink-50/40 pl-10 pr-4 pb-2">
        {members.map(({ grade, product: p }) => (
          <SkuRow key={p.id} grade={grade} product={p} />
        ))}
      </ul>
    </details>
  );
}

/** One grade-variant SKU line inside an expanded model. */
function SkuRow({ grade, product: p }) {
  const price = Number(p.priceUsd) || 0;
  const cost = Number(p.cost) || 0;
  const marginPct = price > 0 ? Math.round(((price - cost) / price) * 100) : 0;
  return (
    <li className="flex items-center gap-3 py-1.5 text-sm">
      {grade ? (
        <span className="chip bg-brand-50 text-brand-700 border border-brand-100 flex-shrink-0">{grade}</span>
      ) : (
        <span className="chip text-ink-500 border border-dashed border-ink-300 flex-shrink-0">—</span>
      )}
      <span className="font-mono text-xs text-ink-600 flex-shrink-0 w-24 truncate" title={p.reference}>
        {p.reference}
      </span>
      <span className="text-ink-500 text-xs truncate flex-1 min-w-0" title={p.subtype || p.name}>
        {p.subtype || ''}
      </span>
      <span className="tabular-nums text-right w-24 flex-shrink-0">{usd(price)}</span>
      <span className="tabular-nums text-right text-ink-500 w-24 flex-shrink-0 hidden sm:inline">{usd(cost)}</span>
      <span className="tabular-nums text-right text-ink-500 w-12 flex-shrink-0 hidden lg:inline">{marginPct}%</span>
    </li>
  );
}
