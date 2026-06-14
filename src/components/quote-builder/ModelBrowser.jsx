import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, PackageSearch, ChevronRight, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { searchProducts, catalogCategories, productsByCategory } from '../../db/database.js';
import { groupFamilies, productForGrade, familyStock } from '../../lib/catalog.js';
import { formatMoney } from '../../lib/format.js';
import { ALL_BRANDS, BRAND_LIGNE_ROSET, brandName } from '../../lib/constants.js';
import ImageView from '../ImageView.jsx';

/**
 * Headless body for finding a catalog MODEL (a family of SKUs sharing the
 * 8-digit root, e.g. "Togo Fireside Chair") and picking one. Owns ONLY the
 * search box + the browse/search results; the caller wraps it in whatever
 * chrome it needs and decides what picking a model means (e.g. CatalogPicker
 * advances to the fabric/grade step to insert a new line).
 *
 * Two ways in, mirroring the admin Catalogs section:
 *   • Browse — ONE BRAND at a time (segmented tabs, like the admin's
 *     one-page-per-brand): every CATEGORY of the active brand listed
 *     (collapsed); opening one lazy-loads its models, so nothing pulls the
 *     whole tens-of-thousands-row table. Tabbed rather than mixed because the
 *     two brands' category trees mean nothing interleaved.
 *   • Search — spans EVERY brand (the dealer quotes them all in one quote);
 *     relevance-ranked matches (best first) grouped under their category, each
 *     row naming its brand. Weights name > family > reference, exact > prefix
 *     > word-start > substring. Hits Postgres for a bounded matched set.
 *
 * Self-contained query state (debounced), so it resets cleanly each time the
 * host modal mounts it.
 */
const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });

export default function ModelBrowser({ profileId, onPick }) {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [brand, setBrand] = useState(BRAND_LIGNE_ROSET); // browse-mode brand tab
  const inputRef = useRef(null);

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, []);

  // Debounce the query so each keystroke isn't its own request.
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);

  const searching = dq.length > 0;

  // Two-band flex column: a PINNED header (search + brand tabs) that never
  // scrolls, over a SINGLE scrolling results region. The host (CatalogPicker)
  // gives us a flush, non-scrolling modal body (`flushBody`), so this is the
  // only scroller — the search box stays put even as the list grows long and
  // even with the iOS keyboard up. We own the modal's horizontal padding here.
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 pb-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={q ? 'input pl-9 pr-9 coarse:pr-11' : 'input pl-9'}
            placeholder="Buscar modelo por nombre, referencia o familia…"
            aria-label="Buscar modelo en el catálogo"
            // iOS: a plain text field whose placeholder mentions "nombre" trips
            // the QuickType "AutoFill Contact" bar (and autocorrect mangles
            // references). These attrs declare it a SEARCH box — Buscar return
            // key, no autofill/autocorrect/capitalize. Mirrors GlobalSearch.
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {q && (
            // btn-icon matches the input's 36/44 height exactly, so the clear
            // affordance fills the input's right end as a full-size touch target.
            <button type="button" onClick={() => { setQ(''); inputRef.current?.focus(); }} className="btn-icon absolute right-0 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700" aria-label="Limpiar">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Brand tabs scope BROWSE only; a search spans every brand (each result
            row names its own), so the tabs bow out while a query is typed. */}
        {!searching && <div className="mt-3"><BrandTabs brand={brand} onChange={setBrand} /></div>}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 pb-4">
        {searching
          ? <PickerSearch profileId={profileId} term={dq} onPick={onPick} />
          : <PickerBrowse profileId={profileId} brand={brand} onPick={onPick} />}
      </div>
    </div>
  );
}

/** Segmented brand switcher for browse mode (the ScopeToggle idiom). */
function BrandTabs({ brand, onChange }) {
  const cls = (active) =>
    active
      ? 'px-3 py-1.5 min-h-8 coarse:min-h-11 bg-ink-900 text-ink-50'
      : 'px-3 py-1.5 min-h-8 coarse:min-h-11 text-ink-600 hover:bg-ink-100 active:bg-ink-200 transition-colors';
  return (
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden text-xs font-medium select-none">
      {ALL_BRANDS.map((b) => (
        <button key={b} type="button" onClick={() => onChange(b)} aria-pressed={brand === b} className={cls(brand === b)}>
          {brandName(b)}
        </button>
      ))}
    </div>
  );
}

const NO_CATEGORY = 'Sin categoría';
const NONE_KEY = '__none__';
const SEARCH_LIMIT = 500;

/** Price hint for a model row: a single price when ungraded, else "desde $lo". */
function priceLabel(fam) {
  if (!fam.graded) {
    const p = productForGrade(fam, '');
    return p ? usd(p.priceUsd) : '—';
  }
  const prices = fam.grades.map((g) => Number(productForGrade(fam, g)?.priceUsd) || 0).filter(Boolean);
  return prices.length ? `desde ${usd(Math.min(...prices))}` : '—';
}

/** Sort categories A→Z, sinking the empty ("Sin categoría") bucket to the end. */
function sortCat(a, b) {
  if (!a && b) return 1;
  if (a && !b) return -1;
  return (a || '').localeCompare(b || '', 'es', { sensitivity: 'base' });
}

const byName = (a, b) =>
  (a.name || a.root).localeCompare(b.name || b.root, 'es', { sensitivity: 'base' });

/** Match quality of `needle` against one field: exact > prefix > word-start >
 *  substring > none. */
function matchTier(hay, needle) {
  const h = (hay || '').toLowerCase();
  if (!h || !needle) return 0;
  if (h === needle) return 4;
  if (h.startsWith(needle)) return 3;
  if (h.includes(' ' + needle)) return 2;
  if (h.includes(needle)) return 1;
  return 0;
}

/** Relevance of a model to the query TOKENS — the sum over tokens of each
 *  token's best field match (name > family > reference > category). Summing per
 *  token (rather than scoring the whole phrase) means a multi-word query like
 *  "pukka sofa" ranks "PUKKA MEDIUM SOFA" highly: each word pulls its weight even
 *  when they aren't adjacent. `category` is the bucket the model sits in. */
function relevanceScore(model, category, tokens) {
  let total = 0;
  for (const tok of tokens) {
    total += Math.max(
      matchTier(model.name, tok) * 10,
      matchTier(model.family, tok) * 8,
      matchTier(model.root, tok) * 6,
      matchTier(category, tok) * 3,
    );
  }
  return total;
}

/**
 * Group a flat matched product set into CATEGORY → MODEL, ranked by relevance:
 * models within a category sort best-match-first, and categories sort by their
 * single best match so the closest hit floats to the top.
 */
function groupAndRank(products, tokens) {
  const byCat = new Map();
  for (const p of products || []) {
    const key = (p.category || '').trim();
    const bucket = byCat.get(key);
    if (bucket) bucket.push(p);
    else byCat.set(key, [p]);
  }
  const sections = [];
  for (const [category, items] of byCat) {
    const scored = groupFamilies(items).map((m) => ({ m, s: relevanceScore(m, category, tokens) }));
    scored.sort((a, b) => b.s - a.s || byName(a.m, b.m));
    sections.push({ category, models: scored.map((x) => x.m), best: scored[0]?.s || 0 });
  }
  return sections.sort((a, b) => b.best - a.best || sortCat(a.category, b.category));
}

/** Search mode — relevance-ranked matches grouped by category. Owns its query
 *  so a fresh search shows a loader rather than a stale/empty flash. */
function PickerSearch({ profileId, term, onPick }) {
  const { data: products, loaded } = useLiveQueryStatus(
    () => searchProducts(profileId, term, SEARCH_LIMIT),
    [profileId, term],
    [],
  );
  const tokens = useMemo(
    () => term.toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean),
    [term],
  );
  const sections = useMemo(() => groupAndRank(products, tokens), [products, tokens]);

  if (!loaded) {
    return (
      <div className="px-3 py-10 text-center text-sm text-ink-500 flex items-center justify-center gap-2">
        <Loader2 size={15} className="animate-spin" /> Buscando…
      </div>
    );
  }
  if (sections.length === 0) {
    return <div className="px-3 py-10 text-center text-sm text-ink-500">Sin coincidencias.</div>;
  }
  return (
    <div className="space-y-2">
      {sections.map((section) => (
        <ResultCategory key={section.category || NONE_KEY} section={section} onPick={onPick} showBrand />
      ))}
    </div>
  );
}

/** Browse mode — the active brand's categories, collapsed; opening one
 *  lazy-loads its models. */
function PickerBrowse({ profileId, brand, onPick }) {
  const { data: categories, loaded, error } = useLiveQueryStatus(
    () => catalogCategories(profileId, brand),
    [profileId, brand],
    [],
  );
  const sorted = useMemo(
    () => [...categories].sort((a, b) => sortCat(a.category, b.category)),
    [categories],
  );

  if (!loaded) {
    return (
      <div className="px-3 py-10 text-center text-sm text-ink-500 flex items-center justify-center gap-2">
        <Loader2 size={15} className="animate-spin" /> Cargando inventario…
      </div>
    );
  }
  if (error || sorted.length === 0) {
    return (
      <div className="px-3 py-10 text-center text-sm text-ink-500">
        Catálogo vacío. Impórtalo en <b>Administración › Catálogos</b>.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {sorted.map((c) => (
        // Key includes the brand: both brands can carry a same-named category,
        // and a tab switch must reset the collapsed/lazy-open state.
        <BrowseCategory key={`${brand}|${c.category || NONE_KEY}`} profileId={profileId} brand={brand} category={c.category} count={c.count} onPick={onPick} />
      ))}
    </div>
  );
}

/** One collapsed category in browse mode; lazy-loads its models on first open. */
function BrowseCategory({ profileId, brand, category, count, onPick }) {
  const [everOpened, setEverOpened] = useState(false);
  const label = category || NO_CATEGORY;
  return (
    <details
      className="rounded-lg border border-ink-100 overflow-hidden group/cat"
      onToggle={(e) => { if (e.currentTarget.open) setEverOpened(true); }}
    >
      <summary className="cursor-pointer list-none select-none px-3 py-3 sm:py-2.5 min-h-11 flex items-center justify-between gap-3 hover:bg-ink-50 active:bg-ink-100 transition-colors">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight size={14} className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90" aria-hidden />
          <span className="font-medium text-sm text-ink-900 truncate" title={label}>{label}</span>
        </span>
        <span className="text-[11px] text-ink-400 tabular-nums flex-shrink-0">{count}</span>
      </summary>
      {everOpened && <BrowseCategoryModels profileId={profileId} brand={brand} category={category} onPick={onPick} />}
    </details>
  );
}

/** Lazy body of a browse category — fetches its products and lists the models. */
function BrowseCategoryModels({ profileId, brand, category, onPick }) {
  const { data: products, loaded, error } = useLiveQueryStatus(
    () => productsByCategory(profileId, category, brand),
    [profileId, category, brand],
    [],
  );
  const models = useMemo(() => [...groupFamilies(products)].sort(byName), [products]);

  if (!loaded) {
    return (
      <div className="px-3 py-5 text-center text-sm text-ink-500 flex items-center justify-center gap-2 border-t border-ink-100">
        <Loader2 size={14} className="animate-spin" /> Cargando…
      </div>
    );
  }
  if (error) {
    return <div className="px-3 py-4 text-sm text-red-700 border-t border-ink-100">No se pudieron cargar los productos.</div>;
  }
  if (models.length === 0) {
    return <div className="px-3 py-4 text-sm text-ink-500 border-t border-ink-100">Sin productos.</div>;
  }
  return (
    <div className="border-t border-ink-100 py-1">
      {models.map((m) => <ModelButton key={m.root} model={m} onPick={onPick} />)}
    </div>
  );
}

/** One category of search results — open by default, with its ranked models. */
function ResultCategory({ section, onPick, showBrand = false }) {
  return (
    <details open className="rounded-lg border border-ink-100 overflow-hidden group/cat">
      <summary className="cursor-pointer list-none select-none px-3 py-3 sm:py-2.5 min-h-11 flex items-center justify-between gap-3 hover:bg-ink-50 active:bg-ink-100 transition-colors">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight size={14} className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90" aria-hidden />
          <span className="font-medium text-sm text-ink-900 truncate" title={section.category || NO_CATEGORY}>
            {section.category || NO_CATEGORY}
          </span>
        </span>
        <span className="text-[11px] text-ink-400 tabular-nums flex-shrink-0">{section.models.length}</span>
      </summary>
      <div className="border-t border-ink-100 py-1">
        {section.models.map((m) => <ModelButton key={m.root} model={m} onPick={onPick} showBrand={showBrand} />)}
      </div>
    </details>
  );
}

/** A selectable model row — picking it hands the model up to the caller. Shows
 *  the product's description (its Description-2 text + dimensions) under the name
 *  so the dealer can tell what the model is. `showBrand` leads the secondary
 *  line with the model's brand — for cross-brand lists (search), where the
 *  category heading alone can't tell a Roset hit from a LifestyleGarden one. */
function ModelButton({ model, onPick, showBrand = false }) {
  // Any member SKU carries the model-level descriptor + dimensions (they're
  // the same across grades); take the leading grade's product as the sample.
  const sample = productForGrade(model, model.grades?.[0] || '');
  const description = [sample?.subtype, sample?.dimensions].filter(Boolean).join(' · ');
  const hasPhoto = !!(sample?.imageId || sample?.imageSrc);
  // Inventory gate — tracked models (LSG) show their live stock and an
  // out-of-stock one cannot be picked at all (the store has nothing to sell).
  const stock = familyStock(model);
  const out = stock.tracked && stock.qty <= 0;
  return (
    <button
      type="button"
      onClick={() => { if (!out) onPick(model); }}
      disabled={out}
      title={out ? 'Agotado en LifestyleGarden — no se puede cotizar' : undefined}
      className={`w-full text-left rounded-md px-3 py-2.5 min-h-11 flex items-center gap-3 transition-colors ${
        out ? 'opacity-50 cursor-not-allowed' : 'hover:bg-ink-50 active:bg-ink-100'
      }`}
    >
      {hasPhoto ? (
        // The catalog's own photo (LSG); LR rows have none and keep the glyph.
        <ImageView
          id={sample.imageId}
          fallbackUrl={sample.imageSrc || null}
          alt=""
          className="w-9 h-9 rounded-md object-cover bg-ink-100 flex-shrink-0"
          placeholderClassName="w-9 h-9 rounded-md bg-ink-100 flex-shrink-0"
        />
      ) : (
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-md bg-ink-100 text-ink-500 flex-shrink-0">
          <PackageSearch size={15} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-900 truncate">{model.name || model.root}</span>
        <span className="block text-[11px] text-ink-500 truncate">
          {[showBrand ? brandName(model.brand) : null, model.family, model.graded ? `${model.grades.length} grados` : null].filter(Boolean).join(' · ')}
        </span>
        {description && (
          <span className="block text-[11px] text-ink-400 truncate" title={description}>{description}</span>
        )}
      </span>
      <span className="flex flex-col items-end gap-0.5 flex-shrink-0">
        <span className="text-xs tabular-nums text-ink-700 whitespace-nowrap">{priceLabel(model)}</span>
        {stock.tracked && (
          out
            ? <span className="chip bg-red-50 text-red-700 border border-red-200">Agotado</span>
            : <span className="chip bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums">{stock.qty} en stock</span>
        )}
      </span>
    </button>
  );
}
