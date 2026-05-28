import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, ChevronLeft, Check, Layers } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import { swatchUrl, heroSwatchUrl } from '../../lib/swatchImage.js';
import { locateColor } from '../../lib/swatchMatch.js';
import { composeSubtype } from '../../lib/subtype.js';

/**
 * Headless material + color chooser — the two-step MaterialList → ColorGrid
 * body lifted out of SwatchPicker so BOTH the quote-pane swatch modal and the
 * catalog flow share one implementation (codes, layout, keyboard nav, empty
 * state). It owns NO chrome: no <Modal>, no model search. The caller wraps it
 * (SwatchPicker in a Modal; CatalogPicker as step 2 of its own modal).
 *
 *   1. Material list — search by name/grade/color, filter by category
 *      (Telas / Pieles / Outdoor). When `gradeFilter` is set the list is
 *      restricted to materials whose grade ∈ gradeFilter (the catalog flow
 *      passes the selected model's grades here).
 *   2. Color grid — after picking a material the dealer sees its colors as a
 *      chip grid. Picking a color (or "Sin color específico") fires
 *      onPick(material, color|null).
 *
 * Props:
 *   materials      catalog materials (already loaded by the caller)
 *   gradeFilter?   string[] of grade letters to restrict the material list to
 *   currentGrade   the line's current grade (informational hint in the list)
 *   currentFabric  the line's current fabric label (drives the "active" color
 *                  highlight and, with autoDrill, which material to pre-open)
 *   autoDrill?     when true, locate the material the current grade/fabric
 *                  refers to and start in its ColorGrid (re-editing a line)
 *   onPick         (material, color|null) — the chosen combination
 *   onTitleChange? (title) — lets the wrapper sync its modal heading with the
 *                  current step ("Elegir material" vs "<material> · elige color")
 */
export default function MaterialColorPicker({
  materials,
  gradeFilter,
  currentGrade,
  currentFabric,
  autoDrill = false,
  onPick,
  onTitleChange,
}) {
  const list = materials || [];

  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [picked, setPicked] = useState(null);   // material the dealer drilled into
  const inputRef = useRef(null);

  // When re-editing a line that already carries a material, jump straight into
  // that material's ColorGrid. Match on the embedded #code/name (NOT a filtered
  // index, which shifts as the search term changes) via locateColor. We wait
  // until the materials have actually loaded (list non-empty) so an async
  // fetch that resolves AFTER mount still drills; runs once thereafter, and
  // clearing `picked` afterwards (Volver) returns to the list.
  const didAutoDrill = useRef(false);
  useEffect(() => {
    if (didAutoDrill.current || !autoDrill || list.length === 0) return;
    didAutoDrill.current = true;
    const hit = locateColor(list, composeSubtype(currentGrade, currentFabric));
    if (hit?.material) setPicked(hit.material);
    else queueMicrotask(() => inputRef.current?.focus());
  }, [autoDrill, list, currentGrade, currentFabric]);

  const allowGrade = useMemo(() => {
    if (!gradeFilter || gradeFilter.length === 0) return null;
    return new Set(gradeFilter.map((g) => String(g).toUpperCase()));
  }, [gradeFilter]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list
      .filter((m) => (allowGrade ? allowGrade.has(String(m.grade || '').toUpperCase()) : true))
      .filter((m) => (category ? m.category === category : true))
      .filter((m) => {
        if (!needle) return true;
        if (m.name?.toLowerCase().includes(needle)) return true;
        if (m.grade?.toLowerCase() === needle) return true;
        if (m.colors?.some((c) => c.name?.toLowerCase().includes(needle) || c.code?.includes(needle))) return true;
        return false;
      })
      .sort((a, b) => {
        const ca = (a.category || '').localeCompare(b.category || '');
        if (ca) return ca;
        return (a.name || '').localeCompare(b.name || '');
      });
  }, [list, q, category, allowGrade]);

  useEffect(() => { setActiveIdx(0); }, [q, category, filtered.length]);

  // Keep the wrapper's heading in sync with the current step.
  useEffect(() => {
    onTitleChange?.(picked ? `${picked.name} · elige color` : 'Elegir material');
  }, [picked, onTitleChange]);

  function onKey(e) {
    if (picked) {
      if (e.key === 'Escape') { e.preventDefault(); setPicked(null); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = filtered[activeIdx];
      if (!m) return;
      if (!m.colors?.length) onPick(m, null);
      else setPicked(m);
    }
  }

  return (
    <div onKeyDown={onKey}>
      {picked ? (
        <ColorGrid
          material={picked}
          onBack={() => setPicked(null)}
          onPick={(color) => onPick(picked, color)}
          currentFabric={currentFabric}
        />
      ) : (
        <MaterialList
          materials={filtered}
          total={list.length}
          gradeFiltered={!!allowGrade}
          q={q}
          setQ={setQ}
          category={category}
          setCategory={setCategory}
          activeIdx={activeIdx}
          setActiveIdx={setActiveIdx}
          onPick={(m) => {
            if (!m.colors?.length) onPick(m, null);
            else setPicked(m);
          }}
          inputRef={inputRef}
          currentGrade={currentGrade}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Step 1 — material list                                                    */
/* -------------------------------------------------------------------------- */

function MaterialList({
  materials, total, gradeFiltered, q, setQ, category, setCategory,
  activeIdx, setActiveIdx, onPick, inputRef, currentGrade,
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
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, grade o color…"
            className="input pl-9"
            autoFocus
          />
        </div>
        <div className="inline-flex rounded-md border border-ink-200 bg-white text-xs flex-shrink-0">
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
              className={`px-2.5 py-1.5 ${i > 0 ? 'border-l border-ink-200' : ''} ${
                category === c.k ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {currentGrade && !gradeFiltered && (
        <div className="text-[11px] text-ink-500">
          La línea actual tiene <b className="text-ink-700">Grade {currentGrade}</b>; al elegir un material se reemplaza por el grade del catálogo.
        </div>
      )}

      <ul className="max-h-[60vh] overflow-y-auto -mx-1 divide-y divide-ink-100 border-y border-ink-100">
        {materials.length === 0 ? (
          <li className="px-3 py-8 text-center text-sm text-ink-500">Sin resultados.</li>
        ) : materials.map((m, idx) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onPick(m)}
              onMouseEnter={() => setActiveIdx(idx)}
              className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${
                activeIdx === idx ? 'bg-ink-100' : 'hover:bg-ink-50'
              }`}
            >
              {/* Material hero = the first color that carries a photo
                  (there's no separate material-level image). Placeholder
                  tile otherwise. The category dot remains as the small
                  colour-coded chip in the corner so the dealer can still
                  read fabric / leather / outdoor at a glance even when
                  no photo exists yet. */}
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
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="font-medium text-ink-900 truncate">{m.name}</span>
                  {m.grade && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-brand-50 text-brand-700 border border-brand-100 flex-shrink-0">
                      Grade {m.grade}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-500 mt-0.5 truncate">
                  {m.composition || ' '}
                </div>
              </div>
              <div className="text-right text-xs text-ink-500 tabular-nums flex-shrink-0">
                {m.price != null && (
                  <div className="text-ink-700 font-medium">
                    ${m.price}
                    <span className="text-ink-400 ml-0.5">
                      /{m.priceUnit === 'sm' ? 'm²' : 'yd'}
                    </span>
                  </div>
                )}
                <div className="text-[10px]">{m.colors?.length || 0} colores</div>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <div className="text-[10px] text-ink-400 text-right">
        {materials.length} de {total} materiales · ↑↓ navegar · ↵ elegir · Esc cerrar
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — color grid                                                       */
/* -------------------------------------------------------------------------- */

function ColorGrid({ material, onBack, onPick, currentFabric }) {
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="btn-ghost text-xs"
        >
          <ChevronLeft size={14} /> Volver al catálogo
        </button>
        <div className="flex-1 text-right text-[11px] text-ink-500">
          {material.grade && <span className="font-medium text-ink-700">Grade {material.grade}</span>}
          {material.price != null && (
            <span className="ml-2 tabular-nums">
              ${material.price}/{material.priceUnit === 'sm' ? 'm²' : 'yd'}
            </span>
          )}
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
          autoFocus
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
                  className={`text-left p-2 rounded border transition-colors flex items-center gap-2 min-w-0 ${
                    active
                      ? 'border-brand-300 bg-brand-50'
                      : 'border-ink-200 hover:border-ink-400 hover:bg-ink-50'
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
                  <span className="flex-1 min-w-0 text-sm text-ink-900 truncate">{c.name}</span>
                  <span className="text-[10px] text-ink-500 font-mono tabular-nums flex-shrink-0">
                    #{c.code}
                  </span>
                  {active && <Check size={12} className="text-brand-700 flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-ink-100">
        <button
          type="button"
          onClick={() => onPick(null)}
          className="btn-ghost text-xs text-ink-500"
          title="Usar la tela sin elegir un color específico"
        >
          <X size={12} /> Sin color específico
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
