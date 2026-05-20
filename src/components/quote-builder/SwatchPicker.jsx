import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, ChevronLeft, Check, Layers } from 'lucide-react';
import Modal from '../Modal.jsx';
import ImageView from '../ImageView.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';

/**
 * Modal picker for selecting a material + color combination from the
 * catalog and committing it back to a quote line.
 *
 * Two-step flow:
 *   1. Material list — search by name/grade/color across the team's
 *      catalog, filter by category (Telas / Pieles / Outdoor). Each
 *      row shows name, grade pill, price/unit, color count.
 *   2. Color grid — after picking a material, the dealer sees its
 *      full color list as a chip grid. Picking a color (or the
 *      generic "Sin color específico") fires onSelect with the
 *      composed payload.
 *
 * The caller (QuoteLineItem's grade/fabric row) receives:
 *   { grade, fabric }
 * where `fabric` is "<MATERIAL NAME> · <COLOR NAME> (#code)" — the
 * exact same shape the dealer would have typed by hand, just
 * generated from canonical data so the codes don't drift.
 *
 * Design-system reuse:
 *   - Modal primitive owns chrome (overlay, close, sizing)
 *   - Same Search + autofocus + arrow-key navigation as
 *     CustomerPicker / ProfessionalPicker / FamilyPicker
 *   - Status pill + brand-50 chip patterns from /admin/materials
 *
 * Empty-catalog state: the picker shows a friendly nudge to import
 * the Ligne Roset 10.2025 list from /admin/materials. We don't
 * trigger the import inline because the catalog is admin-scoped.
 */
export default function SwatchPicker({ open, onClose, onSelect, currentGrade, currentFabric }) {
  const { profileId } = useApp();
  const materials = useLiveQuery(
    () => (profileId ? db.materials.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId, open],   // re-query on open so a freshly-imported catalog shows up without remounting
    [],
  );

  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [picked, setPicked] = useState(null);   // material the dealer drilled into
  const inputRef = useRef(null);

  // Reset state every time the modal opens — without this the picker
  // remembers the previous quote line's drilled-into material and the
  // dealer sees stale colors when they tap from a different line.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setCategory('');
    setActiveIdx(0);
    setPicked(null);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return materials
      .filter((m) => (category ? m.category === category : true))
      .filter((m) => {
        if (!needle) return true;
        if (m.name?.toLowerCase().includes(needle)) return true;
        if (m.grade?.toLowerCase() === needle) return true;
        if (m.colors?.some((c) => c.name?.toLowerCase().includes(needle) || c.code?.includes(needle))) return true;
        return false;
      })
      .sort((a, b) => {
        const ca = a.category.localeCompare(b.category);
        if (ca) return ca;
        return (a.name || '').localeCompare(b.name || '');
      });
  }, [materials, q, category]);

  useEffect(() => { setActiveIdx(0); }, [q, category, filtered.length]);

  function commit(material, color) {
    const fabric = composeFabric(material, color);
    // Pre-fill the swatch from the chosen color's own photo when it has
    // one. We deliberately do NOT fall back to another color's picture —
    // a wrong-colour swatch is worse than none. When the color has no
    // photo the line's swatch slot lets the dealer add it inline.
    const swatchImageId = (color && color.imageId) || null;
    onSelect({ grade: material.grade || '', fabric, swatchImageId });
    onClose();
  }

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
      // No colors? Commit straight away with just the material name.
      if (!m.colors?.length) commit(m, null);
      else setPicked(m);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={picked ? `${picked.name} · elige color` : 'Elegir material'} size="lg">
      <div onKeyDown={onKey}>
        {picked ? (
          <ColorGrid
            material={picked}
            onBack={() => setPicked(null)}
            onPick={(color) => commit(picked, color)}
            currentFabric={currentFabric}
          />
        ) : (
          <MaterialList
            materials={filtered}
            total={materials.length}
            q={q}
            setQ={setQ}
            category={category}
            setCategory={setCategory}
            activeIdx={activeIdx}
            setActiveIdx={setActiveIdx}
            onPick={(m) => {
              if (!m.colors?.length) commit(m, null);
              else setPicked(m);
            }}
            inputRef={inputRef}
            currentGrade={currentGrade}
          />
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Step 1 — material list                                                    */
/* -------------------------------------------------------------------------- */

function MaterialList({
  materials, total, q, setQ, category, setCategory,
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

      {currentGrade && (
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
                {heroImageId(m) ? (
                  <ImageView
                    id={heroImageId(m)}
                    alt={m.name}
                    className="w-10 h-10 object-cover rounded border border-ink-100 bg-white"
                  />
                ) : (
                  <div className="w-10 h-10 rounded border border-dashed border-ink-200 bg-ink-50" aria-hidden />
                )}
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
              // Color swatch: the color's own photo, else a dashed
              // placeholder. No cross-color fallback — showing one
              // color's picture for another would mislead. Colors get
              // their photos in /admin/materials or inline from a
              // quote line's swatch slot.
              const swatchId = c.imageId || null;
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
                  {swatchId ? (
                    <ImageView
                      id={swatchId}
                      alt={c.name}
                      className="w-8 h-8 object-cover rounded border border-ink-100 bg-white flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded border border-dashed border-ink-200 bg-ink-50 flex-shrink-0" aria-hidden />
                  )}
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

/**
 * Compose the fabric portion of a quote line's subtype.
 *
 *   material + color → "MATERIAL · COLOR (#code)"
 *   material only    → "MATERIAL"
 *
 * The returned string lands as the second segment of subtype.js's
 * composeSubtype(grade, fabric), so the on-screen + PDF render stays
 * consistent with hand-typed values.
 */
function composeFabric(material, color) {
  const name = material.name || '';
  if (!color) return name;
  const colorBit = color.code ? `${color.name} (#${color.code})` : color.name;
  return name ? `${name} · ${colorBit}` : colorBit;
}
