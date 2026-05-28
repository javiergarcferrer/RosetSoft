import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, PackageSearch, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import Modal from '../Modal.jsx';
import MaterialColorPicker from './MaterialColorPicker.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../../db/hooks.js';
import { db, searchProducts, catalogCategories, productsByCategory } from '../../db/database.js';
import { groupFamilies, productForGrade } from '../../lib/catalog.js';
import { composeSubtype, composeFabricLabel } from '../../lib/subtype.js';
import { formatMoney } from '../../lib/format.js';

/**
 * Catalog picker — the model → fabric(grade)→ price quote flow.
 *
 *   Step 1: find a MODEL (a family of SKUs sharing the 8-digit root, e.g.
 *           "Togo Fireside Chair"). Two ways in:
 *             • Browse — every CATEGORY listed (collapsed); opening one
 *               lazy-loads its models. Mirrors the admin Catalog so the dealer
 *               navigates the catalog the same way everywhere.
 *             • Search — relevance-ranked matches (best first), grouped under
 *               their category. Ranking weights name > family > reference and
 *               exact > prefix > word-start > substring.
 *   Step 2: ONE combined step — a list of fabrics available for that model's
 *           grades, each row showing the fabric, its grade, and the model's
 *           PRICE in that grade. Picking one fills the quote line.
 *
 * Non-graded models (tables, lamps, wood chairs) skip step 2 — picking the
 * model inserts its single priced row directly.
 *
 * The catalog is tens of thousands of SKUs, so nothing pulls the whole table:
 * browse lazy-loads one category at a time, search hits Postgres for a bounded
 * matched set. Materials (a small table) load on open as before.
 */
const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });

export default function CatalogPicker({ open, onClose, onInsert }) {
  const { profileId } = useApp();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [sel, setSel] = useState(null);   // selected graded family → step 2
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setDq('');
    setSel(null);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Debounce the query so each keystroke isn't its own request.
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);

  const searching = dq.length > 0;

  const materials = useLiveQuery(
    () => (profileId ? db.materials.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId, open],
    [],
  );

  // Insert a line. `product` carries the price/reference (productForGrade for
  // the chosen grade); `material`+`color` (when present) compose the fabric
  // label and the swatch. Forcing a specific COLOR — not just a grade — means
  // the inserted line lands fully specified ("Grade X — MATERIAL · COLOR
  // (#code)") and its swatch is that color's own photo, mirroring the quote-
  // pane SwatchPicker. A plain (non-upholstered) product keeps its own
  // catalog subtype (the wood finish / variant text).
  function insertProduct(fam, product, grade, material, color) {
    if (!product) return;
    onInsert({
      family: product.family || fam.family,
      reference: product.reference,
      name: product.name,
      dimensions: product.dimensions,
      subtype: (grade || material)
        ? composeSubtype(grade, composeFabricLabel(material, color))
        : (product.subtype || ''),
      unitPrice: product.priceUsd,
      unitCost: product.cost,
      swatchImageId: color?.imageId ?? null,
    });
    onClose();
  }

  function pickFamily(fam) {
    if (!fam.graded) {
      insertProduct(fam, productForGrade(fam, ''), '');
      return;
    }
    setSel(fam);
  }

  // Step 2 — does the catalog carry ANY material in one of this model's
  // grades? Drives the fallback: when none match we let the dealer pick the
  // price tier (grade) directly so the flow still works. The actual material→
  // color choice is delegated to the shared <MaterialColorPicker>, filtered to
  // `sel.grades`.
  const hasGradeMaterials = useMemo(() => {
    if (!sel) return false;
    const grades = new Set(sel.grades.map((g) => String(g).toUpperCase()));
    return materials.some((m) => m.grade && grades.has(String(m.grade).toUpperCase()));
  }, [sel, materials]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={sel ? `${sel.name} · elige la tela` : 'Catálogo'}
    >
      {!sel ? (
        <>
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="input pl-9"
              placeholder="Buscar modelo por nombre, referencia o familia…"
            />
            {q && (
              <button type="button" onClick={() => { setQ(''); inputRef.current?.focus(); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1" aria-label="Limpiar">
                <X size={14} />
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
            {searching
              ? <PickerSearch profileId={profileId} term={dq} onPick={pickFamily} />
              : <PickerBrowse profileId={profileId} onPick={pickFamily} />}
          </div>
        </>
      ) : (
        <>
          <button type="button" onClick={() => setSel(null)} className="back-link"><ChevronLeft size={12} /> Volver a modelos</button>
          {!hasGradeMaterials ? (
            // No fabric in the catalog for this model's grades — let the dealer
            // pick the price tier (grade) directly so the flow still works.
            <div className="max-h-[60vh] overflow-y-auto -mx-1">
              <div className="px-3 pb-2 text-[11px] text-ink-500">Sin telas del catálogo para estos grados — elige el grado por precio:</div>
              {sel.grades.map((g) => {
                const p = productForGrade(sel, g);
                return (
                  <button key={g} type="button" onClick={() => insertProduct(sel, p, g)} className="w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 flex items-center justify-between gap-3 hover:bg-ink-50 transition-colors">
                    <span className="chip bg-ink-100 text-ink-700 border border-ink-200">Grado {g}</span>
                    <span className="text-sm tabular-nums text-ink-900 whitespace-nowrap">{usd(p?.priceUsd)}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            // Shared material→color body, restricted to the model's grades.
            // Picking forces a specific COLOR before placing: the product
            // (price/reference) comes from the material's own grade, the
            // subtype + swatch from the chosen color.
            <MaterialColorPicker
              materials={materials}
              gradeFilter={sel.grades}
              family={sel}
              currentGrade=""
              currentFabric=""
              onPick={(material, color) => {
                const grade = String(material.grade || '').toUpperCase();
                insertProduct(sel, productForGrade(sel, grade), grade, material, color);
              }}
            />
          )}
        </>
      )}
    </Modal>
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

/** Relevance of a model to the query — best field match, weighting the model
 *  name over its family over its reference. */
function relevanceScore(model, needle) {
  return Math.max(
    matchTier(model.name, needle) * 10,
    matchTier(model.family, needle) * 8,
    matchTier(model.root, needle) * 6,
  );
}

/**
 * Group a flat matched product set into CATEGORY → MODEL, ranked by relevance:
 * models within a category sort best-match-first, and categories sort by their
 * single best match so the closest hit floats to the top.
 */
function groupAndRank(products, needle) {
  const byCat = new Map();
  for (const p of products || []) {
    const key = (p.category || '').trim();
    const bucket = byCat.get(key);
    if (bucket) bucket.push(p);
    else byCat.set(key, [p]);
  }
  const sections = [];
  for (const [category, items] of byCat) {
    const scored = groupFamilies(items).map((m) => ({ m, s: relevanceScore(m, needle) }));
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
  const needle = useMemo(() => term.toLowerCase().replace(/\s+/g, ' ').trim(), [term]);
  const sections = useMemo(() => groupAndRank(products, needle), [products, needle]);

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
        <ResultCategory key={section.category || NONE_KEY} section={section} onPick={onPick} />
      ))}
    </div>
  );
}

/** Browse mode — every category, collapsed; opening one lazy-loads its models. */
function PickerBrowse({ profileId, onPick }) {
  const { data: categories, loaded, error } = useLiveQueryStatus(
    () => catalogCategories(profileId),
    [profileId],
    [],
  );
  const sorted = useMemo(
    () => [...categories].sort((a, b) => sortCat(a.category, b.category)),
    [categories],
  );

  if (!loaded) {
    return (
      <div className="px-3 py-10 text-center text-sm text-ink-500 flex items-center justify-center gap-2">
        <Loader2 size={15} className="animate-spin" /> Cargando catálogo…
      </div>
    );
  }
  if (error || sorted.length === 0) {
    return (
      <div className="px-3 py-10 text-center text-sm text-ink-500">
        Catálogo vacío. Impórtalo en <b>Administración › Catálogo</b>.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {sorted.map((c) => (
        <BrowseCategory key={c.category || NONE_KEY} profileId={profileId} category={c.category} count={c.count} onPick={onPick} />
      ))}
    </div>
  );
}

/** One collapsed category in browse mode; lazy-loads its models on first open. */
function BrowseCategory({ profileId, category, count, onPick }) {
  const [everOpened, setEverOpened] = useState(false);
  const label = category || NO_CATEGORY;
  return (
    <details
      className="rounded-lg border border-ink-100 overflow-hidden group/cat"
      onToggle={(e) => { if (e.currentTarget.open) setEverOpened(true); }}
    >
      <summary className="cursor-pointer list-none select-none px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-ink-50">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight size={14} className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90" aria-hidden />
          <span className="font-medium text-sm text-ink-900 truncate" title={label}>{label}</span>
        </span>
        <span className="text-[11px] text-ink-400 tabular-nums flex-shrink-0">{count}</span>
      </summary>
      {everOpened && <BrowseCategoryModels profileId={profileId} category={category} onPick={onPick} />}
    </details>
  );
}

/** Lazy body of a browse category — fetches its products and lists the models. */
function BrowseCategoryModels({ profileId, category, onPick }) {
  const { data: products, loaded, error } = useLiveQueryStatus(
    () => productsByCategory(profileId, category),
    [profileId, category],
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
function ResultCategory({ section, onPick }) {
  return (
    <details open className="rounded-lg border border-ink-100 overflow-hidden group/cat">
      <summary className="cursor-pointer list-none select-none px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-ink-50">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight size={14} className="text-ink-400 flex-shrink-0 transition-transform group-open/cat:rotate-90" aria-hidden />
          <span className="font-medium text-sm text-ink-900 truncate" title={section.category || NO_CATEGORY}>
            {section.category || NO_CATEGORY}
          </span>
        </span>
        <span className="text-[11px] text-ink-400 tabular-nums flex-shrink-0">{section.models.length}</span>
      </summary>
      <div className="border-t border-ink-100 py-1">
        {section.models.map((m) => <ModelButton key={m.root} model={m} onPick={onPick} />)}
      </div>
    </details>
  );
}

/** A selectable model row — picking it advances to fabric/grade (or inserts a
 *  non-graded model directly). Shows the product's description (its Description-2
 *  text + dimensions) under the name so the dealer can tell what the model is. */
function ModelButton({ model, onPick }) {
  // Any member SKU carries the model-level descriptor + dimensions (they're
  // the same across grades); take the leading grade's product as the sample.
  const sample = productForGrade(model, model.grades?.[0] || '');
  const description = [sample?.subtype, sample?.dimensions].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={() => onPick(model)}
      className="w-full text-left rounded-md px-3 py-2 flex items-center gap-3 hover:bg-ink-50 transition-colors"
    >
      <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-ink-100 text-ink-500 flex-shrink-0">
        <PackageSearch size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-900 truncate">{model.name || model.root}</span>
        <span className="block text-[11px] text-ink-500">
          {[model.family, model.graded ? `${model.grades.length} grados` : null].filter(Boolean).join(' · ')}
        </span>
        {description && (
          <span className="block text-[11px] text-ink-400 truncate" title={description}>{description}</span>
        )}
      </span>
      <span className="text-sm tabular-nums text-ink-700 whitespace-nowrap">{priceLabel(model)}</span>
    </button>
  );
}
