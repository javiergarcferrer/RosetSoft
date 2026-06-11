import { useEffect, useMemo, useState } from 'react';
import { Search, X, Check, Plus, Loader2 } from 'lucide-react';
import Modal from '../Modal.jsx';
import Select from '../primitives/Select.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { searchProducts } from '../../db/database.js';
import { groupFamilies, productForGrade } from '../../lib/catalog.js';
import { composeSubtype, GRADE_GROUPS, SPECIAL_GRADES } from '../../lib/subtype.js';
import { formatMoney } from '../../lib/format.js';
import { brandName } from '../../lib/constants.js';

/**
 * Multi-add — the fast path for assembling a modular composition from its
 * complete elements. Search the catalog, CHECK several models, pick ONE grade
 * for all of them, and add them in a single step as compound components (or as
 * price RANGES when no grade is chosen, to pin fabrics later). Instead of
 * "Agregar componente → buscar → elegir → repetir" once per module, the dealer
 * picks the grade once and ticks the modules.
 *
 * Reuses the same data path as ModelBrowser/CatalogPicker (searchProducts →
 * groupFamilies → productForGrade), so prices and references match the rest of
 * the catalog flow exactly. The host (ComponentsPanel) decides what "add" means
 * by mapping each seed into a component.
 */
const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });
const SEARCH_LIMIT = 500;

export default function MultiAddPicker({ open, onClose, onAddMany }) {
  const { profileId } = useApp();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [grade, setGrade] = useState('');                 // '' = sin material (rango)
  const [picked, setPicked] = useState(() => new Map());  // root → CatalogFamily

  // Fresh state every open. The list is search-driven, so nothing else lingers.
  useEffect(() => {
    if (open) { setQ(''); setDq(''); setGrade(''); setPicked(new Map()); }
  }, [open]);

  // Debounce the query so each keystroke isn't its own request (mirrors ModelBrowser).
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);

  const { data: products, loaded } = useLiveQueryStatus(
    () => (dq ? searchProducts(profileId, dq, SEARCH_LIMIT) : Promise.resolve([])),
    [profileId, dq],
    [],
  );
  const families = useMemo(
    () => [...groupFamilies(products)].sort((a, b) =>
      (a.name || a.root).localeCompare(b.name || b.root, 'es', { sensitivity: 'base' })),
    [products],
  );

  function toggle(fam) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(fam.root)) next.delete(fam.root);
      else next.set(fam.root, fam);
      return next;
    });
  }

  // Seed one family at the chosen grade (or a price range when grade is blank).
  // The catalog "Description 2" (the model's finish/variant) always rides in
  // `productDescription` — the read-only secondary identity — mirroring the
  // single-add CatalogPicker, so the `subtype` slot only ever holds the fabric
  // (graded) or stays empty (non-graded / range); a grade letter is never
  // stamped on a non-graded model.
  function seedFor(fam) {
    if (!fam.graded) {
      const p = productForGrade(fam, '');
      return p ? { name: p.name || fam.name, reference: p.reference, dimensions: p.dimensions, subtype: '', productDescription: p.subtype || '', unitPrice: Number(p.priceUsd) || 0, imageId: p.imageId ?? null, swatchImageId: null } : null;
    }
    if (!grade) {
      const lo = productForGrade(fam, fam.grades[0]);
      const hi = productForGrade(fam, fam.grades[fam.grades.length - 1]);
      if (!lo || !hi) return null;
      const min = Number(lo.priceUsd) || 0;
      const max = Number(hi.priceUsd) || 0;
      return { name: lo.name || fam.name, reference: lo.reference, dimensions: lo.dimensions, subtype: '', productDescription: lo.subtype || '', unitPrice: min, priceMin: min, priceMax: max, imageId: lo.imageId ?? null, swatchImageId: null };
    }
    const p = productForGrade(fam, grade);
    return p ? { name: p.name || fam.name, reference: p.reference, dimensions: p.dimensions, subtype: composeSubtype(grade, ''), productDescription: p.subtype || '', unitPrice: Number(p.priceUsd) || 0, imageId: p.imageId ?? null, swatchImageId: null } : null;
  }

  function add() {
    const seeds = [...picked.values()].map(seedFor).filter(Boolean);
    if (seeds.length) onAddMany(seeds);
    onClose();
  }

  const count = picked.size;

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Agregar varios elementos">
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="input pl-9"
          placeholder="Buscar modelo por nombre, referencia o familia…"
          autoFocus
        />
        {q && (
          <button type="button" onClick={() => setQ('')} className="btn-icon absolute right-0.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700" aria-label="Limpiar">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-[11px] font-medium text-ink-500 whitespace-nowrap">Grado para todos:</span>
        <Select variant="ghost" value={grade} onChange={setGrade} aria-label="Grado para todos los elementos" className="flex-1 min-w-0">
          <option value="">Sin material · rango</option>
          {GRADE_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.grades.map((g) => <option key={g} value={g}>Grade {g}</option>)}
            </optgroup>
          ))}
          <optgroup label="Otros">
            {SPECIAL_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
          </optgroup>
        </Select>
      </div>

      <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1 space-y-0.5">
        {!dq ? (
          <div className="px-3 py-10 text-center text-sm text-ink-500">Escribe para buscar los elementos del modelo.</div>
        ) : !loaded ? (
          <div className="px-3 py-10 text-center text-sm text-ink-500 flex items-center justify-center gap-2">
            <Loader2 size={15} className="animate-spin" /> Buscando…
          </div>
        ) : families.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-ink-500">Sin coincidencias.</div>
        ) : (
          families.map((fam) => (
            <MultiRow key={fam.root} fam={fam} grade={grade} checked={picked.has(fam.root)} onToggle={() => toggle(fam)} />
          ))
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 pt-3">
        <span className="text-xs text-ink-500 tabular-nums">{count} seleccionado{count === 1 ? '' : 's'}</span>
        {/* The single loudest action in this modal — the brand CTA. */}
        <button
          type="button"
          onClick={add}
          disabled={!count}
          className="btn-brand"
        >
          <Plus size={16} aria-hidden />
          Agregar {count || ''} {count === 1 ? 'elemento' : 'elementos'}
        </button>
      </div>
    </Modal>
  );
}

/** One checkable model row — shows the price at the chosen grade, the range when
 *  none is chosen, or "no aplica" when the model isn't offered in that grade
 *  (then it can't be ticked). */
function MultiRow({ fam, grade, checked, onToggle }) {
  const offered = grade ? !!productForGrade(fam, grade) : true;
  const priceLabel = !grade
    ? (fam.graded
        ? `${usd(productForGrade(fam, fam.grades[0])?.priceUsd)} – ${usd(productForGrade(fam, fam.grades[fam.grades.length - 1])?.priceUsd)}`
        : usd(productForGrade(fam, '')?.priceUsd))
    : (offered ? usd(productForGrade(fam, grade)?.priceUsd) : 'no aplica');
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!offered}
      className={`w-full text-left rounded-md px-3 py-2.5 min-h-11 flex items-center gap-3 transition-colors ${
        checked ? 'bg-brand-50' : 'hover:bg-ink-50 active:bg-ink-100'
      } ${!offered ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <span className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border-2 transition-colors ${
        checked ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300 bg-white'
      }`}>
        {checked && <Check size={11} strokeWidth={3} aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-900 truncate">{fam.name || fam.root}</span>
        {/* Search spans every brand catalog — lead with the brand so a Roset
            element and a LifestyleGarden piece can't be confused mid-tick. */}
        <span className="block text-[11px] text-ink-500 truncate">
          {[brandName(fam.brand), fam.family, fam.graded ? `${fam.grades.length} grados` : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="text-xs tabular-nums text-ink-700 whitespace-nowrap flex-shrink-0">{priceLabel}</span>
    </button>
  );
}
