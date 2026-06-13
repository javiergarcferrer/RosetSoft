import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, ChevronLeft, Check, Layers, Plus } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import { swatchUrl, heroSwatchUrl } from '../../lib/swatchImage.js';
import { locateColor } from '../../lib/swatchMatch.js';
import { composeSubtype } from '../../lib/subtype.js';
import { shouldAutoFocusInput } from '../../lib/autofocus.js';
import { fabricKey, isMaterialOffered } from '../../lib/lrCatalog.js';
import { productForGrade } from '../../lib/catalog.js';
import { formatMoney } from '../../lib/format.js';
import { primaryFiber, compositionGroup, NO_COMPOSITION } from '../../lib/composition.js';

/**
 * Headless material + color chooser — the two-step MaterialList → ColorGrid
 * body lifted out of SwatchPicker so BOTH the quote-pane swatch modal and the
 * catalog flow share one implementation (codes, layout, keyboard nav, empty
 * state). It owns NO chrome: no <Modal>, no model search. The caller wraps it
 * (SwatchPicker in a Modal; CatalogPicker as step 2 of its own modal).
 *
 *   1. Material list — search by name/grade/color, filter by category
 *      (Telas / Pieles / Outdoor), sort (name/grade/price/colors/composition)
 *      and optionally GROUP by primary fiber. When `gradeFilter` is set the
 *      list is restricted to materials whose grade ∈ gradeFilter (the catalog
 *      flow passes the selected model's grades here).
 *   2. Color grid — after picking a material the dealer sees its colors as a
 *      chip grid. Picking a color (or "Sin color específico") fires
 *      onPick(material, color|null).
 *
 * Multi-select mode: when `allowMultiSelect` is set the picker shows a segmented
 * toggle at the top — "Reemplazar tela" (the default single-pick drill-down) vs
 * "Agregar opciones". In the latter the list shows checkboxes; the dealer ticks
 * several fabrics and confirms, firing onPickMany([{ material, color }]) once —
 * the quote line appends them as alternative material OPTIONS. Each pick carries
 * the material's hero color (first with a photo, else the first color) so the
 * option chip gets a swatch.
 *
 * Props:
 *   materials      catalog materials (already loaded by the caller)
 *   gradeFilter?   string[] of grade letters to restrict the material list to
 *   nameFilter?    Set<string> of fabricKey(name) values a linked MODEL actually
 *                  offers — restricts the list to in-grade AND offered fabrics.
 *                  A "Mostrar todas" toggle clears it for the session.
 *   currentGrade   the line's current grade (informational hint in the list)
 *   currentFabric  the line's current fabric label (drives the "active" color
 *                  highlight and, with autoDrill, which material to pre-open)
 *   autoDrill?     when true, locate the material the current grade/fabric
 *                  refers to and start in its ColorGrid (re-editing a line)
 *   allowMultiSelect? when true, surface the "Agregar opciones" mode toggle
 *   onPick         (material, color|null) — the chosen combination
 *   onPickMany?    ([{ material, color }]) — the multi-select confirmation
 *   onTitleChange? (title) — lets the wrapper sync its modal heading with the
 *                  current step ("Elegir material" vs "<material> · elige color")
 */
export default function MaterialColorPicker({
  materials,
  gradeFilter,
  nameFilter,
  family = null,
  currentGrade,
  currentFabric,
  autoDrill = false,
  allowMultiSelect = false,
  offeredOnly = true,
  onPick,
  onPickMany,
  onTitleChange,
}) {
  // Hide materials no longer offered — flagged "not in price list" or "not on
  // site" by the catalog import. They stay in the catalog (admin can review /
  // restore) but can't be quoted. Every pick surface (line swatch, catalog
  // insert, client link) routes through here; the admin review list doesn't.
  const list = useMemo(
    () => (offeredOnly ? (materials || []).filter(isMaterialOffered) : (materials || [])),
    [materials, offeredOnly],
  );

  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('name');
  const [groupByFiber, setGroupByFiber] = useState(false);
  const [showAllNames, setShowAllNames] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [picked, setPicked] = useState(null);   // material the dealer drilled into
  const [multiMode, setMultiMode] = useState(false);          // "Agregar opciones" toggle
  const [selected, setSelected] = useState(() => new Set());  // multi-select ids
  const inputRef = useRef(null);

  // Switch between the single-pick drill-down and the multi-select "options"
  // mode. Leaving multi clears the ticked set; entering it leaves any drilled
  // ColorGrid so the dealer lands back on the checkbox list.
  function setMode(multi) {
    setMultiMode(multi);
    if (multi) setPicked(null);
    else setSelected(new Set());
  }

  // When re-editing a line that already carries a material, jump straight into
  // that material's ColorGrid. Match on the embedded #code/name (NOT a filtered
  // index, which shifts as the search term changes) via locateColor. We wait
  // until the materials have actually loaded (list non-empty) so an async
  // fetch that resolves AFTER mount still drills; runs once thereafter, and
  // clearing `picked` afterwards (Volver) returns to the list. Never in
  // multi-select mode — there is no single "current" material to drill to.
  const didAutoDrill = useRef(false);
  useEffect(() => {
    if (didAutoDrill.current || !autoDrill || multiMode || list.length === 0) return;
    didAutoDrill.current = true;
    const hit = locateColor(list, composeSubtype(currentGrade, currentFabric));
    if (hit?.material) setPicked(hit.material);
    else if (shouldAutoFocusInput()) queueMicrotask(() => inputRef.current?.focus());
  }, [autoDrill, multiMode, list, currentGrade, currentFabric]);

  const allowGrade = useMemo(() => {
    if (!gradeFilter || gradeFilter.length === 0) return null;
    return new Set(gradeFilter.map((g) => String(g).toUpperCase()));
  }, [gradeFilter]);

  // A linked model's offered-fabric allowlist. Active only while the dealer
  // hasn't hit "Mostrar todas" (the per-session escape hatch).
  const nameAllow = useMemo(() => {
    if (showAllNames || !nameFilter || nameFilter.size === 0) return null;
    return nameFilter;
  }, [nameFilter, showAllNames]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list
      .filter((m) => (allowGrade ? allowGrade.has(String(m.grade || '').toUpperCase()) : true))
      .filter((m) => (nameAllow ? nameAllow.has(fabricKey(m.name)) : true))
      .filter((m) => (category ? m.category === category : true))
      .filter((m) => {
        if (!needle) return true;
        if (m.name?.toLowerCase().includes(needle)) return true;
        if (m.grade?.toLowerCase() === needle) return true;
        if (m.composition?.toLowerCase().includes(needle)) return true;
        if (m.colors?.some((c) => c.name?.toLowerCase().includes(needle) || c.code?.includes(needle))) return true;
        return false;
      });
  }, [list, q, category, allowGrade, nameAllow]);

  const cmp = useMemo(() => comparator(sort, family), [sort, family]);
  const ordered = useMemo(() => [...filtered].sort(cmp), [filtered, cmp]);

  // When grouping, bucket by primary fiber and order groups alphabetically
  // (the "no composition" bucket last). Each group remembers its start offset
  // into the FLAT display order so keyboard nav (activeIdx) stays a single
  // index across the whole list.
  const groups = useMemo(() => {
    if (!groupByFiber) return null;
    const map = new Map();
    for (const m of ordered) {
      const key = compositionGroup(m.composition);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }
    const keys = [...map.keys()].sort((a, b) => {
      if (a === NO_COMPOSITION) return 1;
      if (b === NO_COMPOSITION) return -1;
      return a.localeCompare(b);
    });
    let start = 0;
    return keys.map((fiber) => {
      const items = map.get(fiber);
      const g = { fiber, items, start };
      start += items.length;
      return g;
    });
  }, [ordered, groupByFiber]);

  // The actual rendered order — flat concatenation of groups when grouping,
  // else the sorted list. activeIdx and Enter index into THIS.
  const displayList = useMemo(
    () => (groups ? groups.flatMap((g) => g.items) : ordered),
    [groups, ordered],
  );

  useEffect(() => { setActiveIdx(0); }, [q, category, sort, groupByFiber, displayList.length]);

  // Keep the wrapper's heading in sync with the current step.
  useEffect(() => {
    if (multiMode) {
      onTitleChange?.(selected.size ? `Elegir materiales · ${selected.size}` : 'Elegir materiales');
      return;
    }
    onTitleChange?.(picked ? `${picked.name} · elige color` : 'Elegir material');
  }, [picked, multiMode, selected, onTitleChange]);

  function toggle(m) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id);
      else next.add(m.id);
      return next;
    });
  }

  function confirmMany() {
    if (selected.size === 0) return;
    const picks = list
      .filter((m) => selected.has(m.id))
      .map((m) => ({ material: m, color: heroColor(m) }));
    onPickMany?.(picks);
  }

  function activate(m) {
    if (multiMode) { toggle(m); return; }
    if (!m.colors?.length) onPick(m, null);
    else setPicked(m);
  }

  function onKey(e) {
    if (picked) {
      if (e.key === 'Escape') { e.preventDefault(); setPicked(null); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(displayList.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Cmd/Ctrl+Enter confirms the whole multi-selection.
      if (multiMode && (e.metaKey || e.ctrlKey)) { confirmMany(); return; }
      const m = displayList[activeIdx];
      if (m) activate(m);
    }
  }

  return (
    <div onKeyDown={onKey}>
      {/* Mode toggle — only when the caller offers the options flow. Replacing
          the line's own fabric vs. adding alternative options the customer can
          choose between live in ONE picker; the toggle swaps between them. */}
      {allowMultiSelect && <ModeToggle multi={multiMode} onChange={setMode} />}
      {picked ? (
        <ColorGrid
          material={picked}
          onBack={() => setPicked(null)}
          onPick={(color) => onPick(picked, color)}
          currentFabric={currentFabric}
          family={family}
        />
      ) : (
        <MaterialList
          displayList={displayList}
          groups={groups}
          total={list.length}
          gradeFiltered={!!allowGrade}
          modelFiltered={!!nameAllow}
          modelHasFilter={!!nameFilter && nameFilter.size > 0}
          showAllNames={showAllNames}
          onToggleShowAllNames={() => setShowAllNames((v) => !v)}
          family={family}
          q={q}
          setQ={setQ}
          category={category}
          setCategory={setCategory}
          sort={sort}
          setSort={setSort}
          groupByFiber={groupByFiber}
          setGroupByFiber={setGroupByFiber}
          activeIdx={activeIdx}
          setActiveIdx={setActiveIdx}
          multiSelect={multiMode}
          selected={selected}
          onActivate={activate}
          onConfirmMany={confirmMany}
          inputRef={inputRef}
          currentGrade={currentGrade}
        />
      )}
    </div>
  );
}

/* Segmented control for the single-pick vs. add-options modes. */
function ModeToggle({ multi, onChange }) {
  const opts = [
    { v: false, label: 'Reemplazar tela' },
    { v: true, label: 'Agregar opciones' },
  ];
  return (
    <div className="flex rounded-md border border-ink-200 bg-surface text-xs mb-3 w-full sm:w-auto sm:inline-flex overflow-hidden">
      {opts.map((o, i) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.v)}
          aria-pressed={multi === o.v}
          className={`flex-1 sm:flex-none px-3 py-1.5 min-h-9 coarse:min-h-11 transition-colors ${i > 0 ? 'border-l border-ink-200' : ''} ${
            multi === o.v ? 'bg-ink-900 text-ink-50' : 'text-ink-600 hover:bg-ink-50 active:bg-ink-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });

/** Sort options surfaced in the list toolbar. */
const SORTS = [
  { k: 'name',   label: 'Nombre A–Z' },
  { k: 'grade',  label: 'Grade' },
  { k: 'price',  label: 'Precio' },
  { k: 'colors', label: 'N.º de colores' },
  { k: 'fiber',  label: 'Composición' },
];

/**
 * Resolved price used for the "Precio" sort. With a catalog MODEL in play
 * (`family`) it's the model's price in the material's grade; otherwise the
 * material's own per-yard / per-m² price. null when neither resolves.
 */
function priceValue(family, m) {
  if (family) {
    const p = productForGrade(family, String(m.grade || '').toUpperCase());
    return p?.priceUsd != null ? Number(p.priceUsd) : null;
  }
  return m.price != null ? Number(m.price) : null;
}

/** Comparator factory for the active sort. Name is the universal tiebreak. */
function comparator(sort, family) {
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  switch (sort) {
    case 'grade':
      return (a, b) => String(a.grade || '').localeCompare(String(b.grade || '')) || byName(a, b);
    case 'price':
      return (a, b) => {
        const pa = priceValue(family, a);
        const pb = priceValue(family, b);
        if (pa == null && pb == null) return byName(a, b);
        if (pa == null) return 1;   // unknown prices sink to the bottom
        if (pb == null) return -1;
        return pa - pb || byName(a, b);
      };
    case 'colors':
      return (a, b) => (b.colors?.length || 0) - (a.colors?.length || 0) || byName(a, b);
    case 'fiber':
      return (a, b) => primaryFiber(a.composition).localeCompare(primaryFiber(b.composition)) || byName(a, b);
    case 'name':
    default:
      return byName;
  }
}

/**
 * Price shown for a material. With a catalog MODEL in play (`family` set — the
 * catalog flow, or a quote line that carries a model), it's the MODEL's USD
 * price upholstered in that material's grade. Without a model it's the
 * material's own per-yard / per-m² price.
 */
function MaterialPrice({ family, material }) {
  if (family) {
    const p = productForGrade(family, String(material.grade || '').toUpperCase());
    return p?.priceUsd != null
      ? <span className="text-ink-700 font-medium">{usd(p.priceUsd)}</span>
      : <span className="text-ink-400">—</span>;
  }
  if (material.price == null) return null;
  return (
    <span className="text-ink-700 font-medium">
      ${material.price}
      <span className="text-ink-400 ml-0.5 font-normal">/{material.priceUnit === 'sm' ? 'm²' : 'yd'}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Step 1 — material list                                                    */
/* -------------------------------------------------------------------------- */

function MaterialList({
  displayList, groups, total, gradeFiltered, modelFiltered, modelHasFilter,
  showAllNames, onToggleShowAllNames, family, q, setQ, category, setCategory,
  sort, setSort, groupByFiber, setGroupByFiber, activeIdx, setActiveIdx,
  multiSelect, selected, onActivate, onConfirmMany, inputRef, currentGrade,
}) {
  if (total === 0) {
    return (
      <div className="text-center py-10">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-ink-100 text-ink-500 mb-3">
          <Layers size={18} />
        </div>
        <div className="text-sm font-medium text-ink-900">Catálogo vacío</div>
        <p className="text-xs text-ink-500 mt-1 max-w-sm mx-auto">
          Pídele al administrador que importe el catálogo Ligne Roset 10.2025 en
          {' '}<span className="font-mono">Administración → Materiales</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, grade, color o composición…"
            className="input pl-9"
            autoFocus={shouldAutoFocusInput()}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-ink-200 bg-surface text-xs w-full sm:w-auto sm:inline-flex overflow-hidden">
            {[
              { k: '', label: 'Todos' },
              { k: 'fabric', label: 'Telas' },
              { k: 'leather', label: 'Pieles' },
              { k: 'outdoor', label: 'Outdoor' },
            ].map((c, i) => (
              <button
                key={c.k}
                type="button"
                onClick={() => setCategory(c.k)}
                aria-pressed={category === c.k}
                className={`flex-1 sm:flex-none px-2.5 py-1.5 min-h-9 coarse:min-h-11 transition-colors ${i > 0 ? 'border-l border-ink-200' : ''} ${
                  category === c.k ? 'bg-ink-900 text-ink-50' : 'text-ink-600 hover:bg-ink-50 active:bg-ink-100'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto sm:ml-auto">
            <label className="inline-flex items-center gap-1 text-[11px] text-ink-500 flex-1 sm:flex-none">
              <span className="hidden sm:inline">Ordenar</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="text-xs border border-ink-200 rounded-md bg-surface text-ink-700 pl-2 pr-6 py-1.5 min-h-9 coarse:min-h-11 shadow-xs transition-shadow focus:outline-none focus:border-brand-500 focus:shadow-focus flex-1 sm:flex-none"
                aria-label="Ordenar materiales"
              >
                {SORTS.map((s) => (
                  <option key={s.k} value={s.k}>{s.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setGroupByFiber((v) => !v)}
              aria-pressed={groupByFiber}
              className={`inline-flex items-center gap-1 text-xs rounded-md border px-2.5 py-1.5 min-h-9 coarse:min-h-11 transition-colors flex-shrink-0 ${
                groupByFiber
                  ? 'bg-ink-900 text-ink-50 border-ink-900'
                  : 'bg-surface text-ink-600 border-ink-200 hover:bg-ink-50 active:bg-ink-100'
              }`}
              title="Agrupar por composición (fibra principal)"
            >
              <Layers size={13} /> Agrupar
            </button>
          </div>
        </div>
      </div>

      {currentGrade && !gradeFiltered && (
        <div className="text-[11px] text-ink-500">
          La línea actual tiene <b className="text-ink-700">Grade {currentGrade}</b>; al elegir un material se reemplaza por el grade del catálogo.
        </div>
      )}

      {/* When the model is linked to its Ligne Roset page, restrict to the
          fabrics it actually offers — with an escape hatch to show every
          in-grade fabric, and a way back to the offered-only set. */}
      {modelHasFilter && (
        <div className="text-[11px] text-ink-500 flex items-center gap-1.5">
          {modelFiltered ? (
            <>
              <span>Mostrando solo las telas <b className="text-ink-700">disponibles para este modelo</b>.</span>
              <button type="button" onClick={onToggleShowAllNames} className="inline-flex items-center rounded-md px-1 -mx-1 min-h-6 coarse:min-h-11 coarse:-my-3 text-brand-700 font-medium hover:underline hover:bg-brand-50 active:bg-brand-100 transition-colors">
                Mostrar todas
              </button>
            </>
          ) : (
            <>
              <span>Mostrando <b className="text-ink-700">todas</b> las telas del grade.</span>
              <button type="button" onClick={onToggleShowAllNames} className="inline-flex items-center rounded-md px-1 -mx-1 min-h-6 coarse:min-h-11 coarse:-my-3 text-brand-700 font-medium hover:underline hover:bg-brand-50 active:bg-brand-100 transition-colors">
                Solo las del modelo
              </button>
            </>
          )}
        </div>
      )}

      {multiSelect && (
        <div className="text-[11px] text-ink-500">
          Marca varias telas para ofrecerlas como <b className="text-ink-700">opciones</b> de esta línea; cada una mostrará su diferencia de precio.
        </div>
      )}

      <ul className="max-h-[60vh] overflow-y-auto -mx-1 divide-y divide-ink-100 border-y border-ink-100">
        {displayList.length === 0 ? (
          <li className="px-3 py-8 text-center text-sm text-ink-500">Sin resultados.</li>
        ) : groups ? (
          groups.map((g) => (
            <li key={g.fiber} className="py-0">
              <div className="sticky top-0 z-[1] bg-surface/95 backdrop-blur px-3 py-1.5 eyebrow flex items-center justify-between">
                <span className="truncate">{g.fiber}</span>
                <span className="text-ink-400 font-normal tabular-nums">{g.items.length}</span>
              </div>
              <ul className="divide-y divide-ink-100">
                {g.items.map((m, localIdx) => {
                  const idx = g.start + localIdx;
                  return (
                    <MaterialRow
                      key={m.id}
                      m={m}
                      active={activeIdx === idx}
                      multiSelect={multiSelect}
                      checked={selected?.has(m.id)}
                      family={family}
                      onHover={() => setActiveIdx(idx)}
                      onActivate={() => onActivate(m)}
                    />
                  );
                })}
              </ul>
            </li>
          ))
        ) : (
          displayList.map((m, idx) => (
            <MaterialRow
              key={m.id}
              m={m}
              active={activeIdx === idx}
              multiSelect={multiSelect}
              checked={selected?.has(m.id)}
              family={family}
              onHover={() => setActiveIdx(idx)}
              onActivate={() => onActivate(m)}
            />
          ))
        )}
      </ul>

      {multiSelect ? (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="text-[10px] text-ink-400">
            {displayList.length} de {total} · {selected?.size || 0} seleccionadas
          </span>
          <button
            type="button"
            onClick={onConfirmMany}
            disabled={!selected?.size}
            className="btn-primary text-xs"
          >
            <Plus size={14} /> Agregar {selected?.size || 0} {selected?.size === 1 ? 'opción' : 'opciones'}
          </button>
        </div>
      ) : (
        <div className="text-[10px] text-ink-400 text-right hidden sm:block">
          {displayList.length} de {total} materiales · ↑↓ navegar · ↵ elegir · Esc cerrar
        </div>
      )}
    </div>
  );
}

/* One row in the material list — shared by the flat and grouped renders. In
   multi-select mode the leading tile becomes a checkbox; otherwise it's the
   material's hero swatch. The composition line is always shown (full text on
   hover) so the dealer reads the fiber make-up at a glance. */
function MaterialRow({ m, active, multiSelect, checked, family, onHover, onActivate }) {
  return (
    <li>
      <button
        type="button"
        onClick={onActivate}
        onMouseEnter={onHover}
        aria-pressed={multiSelect ? !!checked : undefined}
        className={`w-full text-left px-3 py-2.5 min-h-11 flex items-center gap-3 transition-colors ${
          multiSelect && checked ? 'bg-brand-50' : active ? 'bg-ink-100' : 'hover:bg-ink-50 active:bg-ink-100'
        }`}
      >
        {multiSelect && (
          <span
            className={`flex items-center justify-center w-4 h-4 rounded border flex-shrink-0 ${
              checked ? 'bg-brand-600 border-brand-600 text-white' : 'border-ink-300 bg-surface'
            }`}
            aria-hidden
          >
            {checked && <Check size={12} strokeWidth={3} />}
          </span>
        )}
        {/* Material hero = the first color that carries a photo (there's no
            separate material-level image). Placeholder tile otherwise. The
            category dot remains as the small colour-coded chip in the corner
            so the dealer can still read fabric / leather / outdoor at a glance
            even when no photo exists yet. */}
        <div className="relative w-10 h-10 flex-shrink-0">
          <ImageView
            id={heroImageId(m)}
            fallbackUrl={heroSwatchUrl(m)}
            alt={m.name}
            hoverPreview
            className="w-10 h-10 object-cover rounded border border-ink-100 bg-white"
            placeholderClassName="w-10 h-10 rounded border border-dashed border-ink-200 bg-ink-50"
          />
          <span className="absolute -top-1 -right-1">
            <CategoryDot category={m.category} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
            {/* Fabric names are data — wrap, never ellipsize. */}
            <span className="font-medium text-ink-900 min-w-0 break-words">{m.name}</span>
            {m.grade && (
              <span className="chip bg-brand-50 text-brand-700 border border-brand-100 flex-shrink-0">
                Grade {m.grade}
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-500 mt-0.5 truncate" title={m.composition || undefined}>
            {m.composition || '—'}
          </div>
        </div>
        <div className="text-right text-xs text-ink-500 tabular-nums flex-shrink-0">
          <div><MaterialPrice family={family} material={m} /></div>
          <div className="text-[10px] hidden sm:block">{m.colors?.length || 0} colores</div>
        </div>
      </button>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — color grid                                                       */
/* -------------------------------------------------------------------------- */

function ColorGrid({ material, onBack, onPick, currentFabric, family }) {
  const [q, setQ] = useState('');
  const colors = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (material.colors || []).filter((c) => {
      if (!needle) return true;
      return (
        c.name?.toLowerCase().includes(needle) ||
        c.code?.includes(needle)
      );
    });
  }, [material.colors, q]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="btn-ghost text-xs"
        >
          <ChevronLeft size={14} /> Volver al catálogo
        </button>
        <div className="flex-1 text-right text-[11px] text-ink-500 min-w-0">
          {material.grade && <span className="font-medium text-ink-700">Grade {material.grade}</span>}
          <span className="ml-2 tabular-nums"><MaterialPrice family={family} material={material} /></span>
        </div>
      </div>

      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar color o código…"
          className="input pl-9"
          autoFocus={shouldAutoFocusInput()}
        />
      </div>

      <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
        {colors.length === 0 ? (
          <div className="py-8 text-center text-sm text-ink-500">
            Sin coincidencias.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
            {colors.map((c) => {
              const active = currentFabric && currentFabric.includes(c.code);
              // Swatch = the color's uploaded photo, else its own Ligne
              // Roset swatch derived from the code (c_{code}.jpg) — always
              // this exact color, never a cross-color guess. Placeholder
              // only when neither resolves.
              return (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => onPick(c)}
                  aria-pressed={!!active}
                  className={`text-left p-2 min-h-11 rounded-md border transition-colors flex items-center gap-2 min-w-0 ${
                    active
                      ? 'border-brand-300 bg-brand-50 ring-1 ring-inset ring-brand-300'
                      : 'border-ink-200 hover:border-ink-400 hover:bg-ink-50 active:bg-ink-100'
                  }`}
                >
                  <ImageView
                    id={c.imageId || null}
                    fallbackUrl={swatchUrl(c.code)}
                    alt={c.name}
                    hoverPreview
                    className="w-8 h-8 object-cover rounded border border-ink-100 bg-white flex-shrink-0"
                    placeholderClassName="w-8 h-8 rounded border border-dashed border-ink-200 bg-ink-50 flex-shrink-0"
                  />
                  {/* Color names are data — wrap, never ellipsize. */}
                  <span className="flex-1 min-w-0 text-sm text-ink-900 break-words">{c.name}</span>
                  <span className="text-[10px] text-ink-500 font-mono tabular-nums flex-shrink-0 hidden min-[360px]:block">
                    #{c.code}
                  </span>
                  {/* Selected = ring + check, never color alone (color-blind safe). */}
                  {active && <Check size={14} className="text-brand-700 flex-shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-ink-100">
        <button
          type="button"
          onClick={() => onPick(null)}
          className="btn-ghost text-xs text-ink-500"
          title="Usar la tela sin elegir un color específico"
        >
          <X size={14} /> Sin color específico
        </button>
        <span className="text-[10px] text-ink-400">
          {colors.length} de {material.colors?.length || 0} colores
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The material's representative thumbnail: the first color that carries
 * a photo. There is no separate material-level image — a material's
 * "hero" is simply borrowed from its colors, so the catalog grows a face
 * as the dealer photographs swatches.
 */
function heroImageId(material) {
  return material?.colors?.find((c) => c.imageId)?.imageId || null;
}

/**
 * The color used to represent a material in multi-select: the first color
 * with a photo (so the option chip gets a real swatch), else the first
 * color, else null. Mirrors heroImageId's "borrow from colors" rule.
 */
function heroColor(material) {
  const colors = material?.colors || [];
  return colors.find((c) => c.imageId) || colors[0] || null;
}

function CategoryDot({ category }) {
  const palette = {
    fabric:  'bg-amber-400',
    leather: 'bg-rose-500',
    outdoor: 'bg-emerald-500',
  };
  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${palette[category] || 'bg-ink-300'}`}
      title={category}
      aria-hidden
    />
  );
}
