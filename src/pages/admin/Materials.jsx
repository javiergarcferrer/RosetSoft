import { useMemo, useState } from 'react';
import {
  Layers, Plus, Pencil, Trash2, Shield, Check,
  Loader2, X, GripVertical,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import Modal from '../../components/Modal.jsx';
import { DebouncedInput, DebouncedTextarea } from '../../components/DebouncedInput.jsx';
import Thumbnail from '../../components/primitives/Thumbnail.jsx';
import ImageView from '../../components/ImageView.jsx';
import { swatchUrl, heroSwatchUrl } from '../../lib/swatchImage.js';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import { GRADE_GROUPS, SPECIAL_GRADES } from '../../lib/subtype.js';

/**
 * Materials catalog admin page.
 *
 * Manages the fabric / leather / outdoor catalog the quote builder
 * uses to auto-fill grade + color code on each line. Standalone CRUD
 * (table view + modal editor + delete) plus a one-click bulk import
 * of the Ligne Roset 10.2025 USA price list (parsed from the dealer's
 * 3 PDFs and shipped as a JSON seed in src/data/).
 *
 * Why standalone vs a sub-tab of /settings: the catalog is large
 * (~74 materials, ~850 colors) and needs its own search / filter /
 * import surface. /settings stays focused on company info + rates +
 * defaults.
 *
 * Permissions: admin-only — same gate as the other /admin pages. The
 * RLS on `materials` allows any team member to read+write, but the
 * UI restricts editing to admins so an employee can't accidentally
 * delete the entire fabric library mid-quote.
 */
export default function Materials() {
  const { profileId, isAdmin } = useApp();
  const { data: materials, loaded } = useLiveQueryStatus(
    () => db.materials.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(''); // '' = todas | 'fabric' | 'leather' | 'outdoor'
  const [filters, setFilters] = useState({}); // { grade: <grade> }
  const [sort, setSort] = useState({ key: 'category', dir: 'asc' });
  const [editing, setEditing] = useState(null); // material being edited, or 'new'

  // Category tabs (the primary dimension). Counts ride the full materials
  // list so each tab shows "how many would I see if I tapped this",
  // independent of the search needle / secondary filters. The '' key is the
  // "Todas" view — the existing empty-string category already means "all".
  const tabs = useMemo(() => {
    const counts = { fabric: 0, leather: 0, outdoor: 0 };
    for (const m of materials) {
      if (m.category in counts) counts[m.category] += 1;
    }
    return [
      { key: '', label: 'Todas', count: materials.length },
      { key: 'fabric', label: 'Telas', count: counts.fabric },
      { key: 'leather', label: 'Pieles', count: counts.leather },
      { key: 'outdoor', label: 'Outdoor', count: counts.outdoor },
    ];
  }, [materials]);

  // Secondary filter: grade. Options are the catalog's known grades —
  // the alpha grades flattened out of GRADE_GROUPS plus the special
  // non-letter grades (COM, …).
  const gradeFilter = useMemo(() => ({
    key: 'grade',
    label: 'Grade',
    type: 'select',
    placeholder: 'Todos',
    options: [
      ...GRADE_GROUPS.flatMap((g) => g.grades).map((g) => ({ value: g, label: `Grade ${g}` })),
      ...SPECIAL_GRADES.map((g) => ({ value: g, label: g })),
    ],
  }), []);

  const sortOptions = [
    { key: 'category', label: 'Categoría + Nombre' },
    { key: 'name', label: 'Nombre A–Z' },
    { key: 'price', label: 'Precio' },
    { key: 'colors', label: '# colores' },
  ];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const grade = filters.grade;
    const rows = materials
      .filter((m) => (category ? m.category === category : true))
      .filter((m) => (grade ? m.grade === grade : true))
      .filter((m) => {
        if (!q) return true;
        if (m.name?.toLowerCase().includes(q)) return true;
        if (m.grade?.toLowerCase().includes(q)) return true;
        if (m.colors?.some((c) => c.name?.toLowerCase().includes(q) || c.code?.includes(q))) return true;
        return false;
      });

    // Sort. 'category' is the default (category then name); the other keys
    // sort by a single field. Direction multiplier flips asc/desc.
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === 'name') {
        return (a.name || '').localeCompare(b.name || '') * mul;
      }
      if (sort.key === 'price') {
        return ((a.price || 0) - (b.price || 0)) * mul;
      }
      if (sort.key === 'colors') {
        return ((a.colors?.length || 0) - (b.colors?.length || 0)) * mul;
      }
      // category (+ name)
      const ca = a.category.localeCompare(b.category);
      if (ca) return ca * mul;
      return (a.name || '').localeCompare(b.name || '') * mul;
    });
  }, [materials, search, category, filters, sort]);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Catálogo de materiales" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Solo administradores pueden gestionar el catálogo de materiales."
        />
      </>
    );
  }

  async function remove(material) {
    if (!confirm(`¿Eliminar “${material.name}” del catálogo?`)) return;
    await db.materials.delete(material.id);
  }

  return (
    <>
      <PageHeader
        title="Catálogo de materiales"
        subtitle={loaded ? `${materials.length} en catálogo` : ' '}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="btn-primary"
            >
              <Plus size={14} /> Nuevo material
            </button>
          </div>
        }
      />

      <ListSearchHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por nombre, grade o color…"
        tabs={tabs}
        activeTab={category}
        onTabChange={setCategory}
        filters={[gradeFilter]}
        activeFilters={filters}
        onFiltersChange={setFilters}
        sortOptions={sortOptions}
        sort={sort}
        onSortChange={setSort}
        resultCount={filtered.length}
        resultNoun={['material', 'materiales']}
      />

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={6} /></div>
      ) : materials.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="Catálogo vacío"
          description="Importa la lista oficial de Ligne Roset 10.2025 o crea materiales manualmente."
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-[10px] uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="text-left px-3 py-2 w-12">Foto</th>
                  <th className="text-left px-3 py-2">Categoría</th>
                  <th className="text-left px-3 py-2">Nombre</th>
                  <th className="text-left px-3 py-2">Grade</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Precio (USD)</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Medida</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap"># colores</th>
                  <th className="px-3 py-2 w-px" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((m) => (
                  <tr key={m.id} className="hover:bg-ink-50/40">
                    <td className="px-3 py-2">
                      <ImageView
                        id={heroImageId(m)}
                        fallbackUrl={heroSwatchUrl(m)}
                        alt={m.name}
                        hoverPreview
                        className="w-10 h-10 object-cover rounded border border-ink-100 bg-white"
                        placeholderClassName="w-10 h-10 rounded border border-dashed border-ink-200 bg-ink-50"
                      />
                    </td>
                    <td className="px-3 py-2 eyebrow font-normal tracking-wide">
                      {categoryLabel(m.category)}
                    </td>
                    <td className="px-3 py-2 font-medium text-ink-900">{m.name}</td>
                    <td className="px-3 py-2"><GradePill grade={m.grade} /></td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {m.price != null ? `$${m.price} / ${m.priceUnit === 'sm' ? 'm²' : 'yd'}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-500 whitespace-nowrap">
                      {m.measure != null ? `${m.measure} ${m.measureUnit || ''}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-500">{m.colors?.length || 0}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setEditing(m)}
                        className="btn-ghost text-xs"
                        title="Editar"
                      >
                        <Pencil size={12} /> Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(m)}
                        className="btn-ghost text-xs text-red-600 hover:bg-red-50"
                        title="Eliminar"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-sm text-ink-500">
                      Sin resultados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <MaterialEditor
          material={editing === 'new' ? null : editing}
          profileId={profileId}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

// The material's representative thumbnail: the first color that carries
// a photo. There is no separate material-level image — the catalog grows
// a face as the dealer photographs individual color swatches.
function heroImageId(material) {
  return material?.colors?.find((c) => c.imageId)?.imageId || null;
}

function categoryLabel(c) {
  switch (c) {
    case 'fabric':  return 'Tela';
    case 'leather': return 'Piel';
    case 'outdoor': return 'Outdoor';
    default:        return c;
  }
}

function GradePill({ grade }) {
  if (!grade) return <span className="text-ink-400">—</span>;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-brand-50 text-brand-700 border border-brand-100">
      Grade {grade}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Editor modal                                                              */
/* -------------------------------------------------------------------------- */

function MaterialEditor({ material, profileId, onClose }) {
  const isNew = !material;
  const [draft, setDraft] = useState(() => material || {
    category: 'fabric',
    name: '',
    grade: '',
    wearRating: '',
    wearDoubleRubs: null,
    measure: null,
    measureUnit: 'in',
    price: null,
    priceUnit: 'yard',
    composition: '',
    colors: [],
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Color drag-reorder — same HTML5 DnD pattern as the quote line list
  // (LineItemList): the handle is draggable, the row is the drop target,
  // and the indicator sits above the hovered row.
  const [dragColor, setDragColor] = useState(null);
  const [dropColor, setDropColor] = useState(null);

  function set(patch) { setDraft((d) => ({ ...d, ...patch })); }

  function addColor() {
    set({ colors: [...(draft.colors || []), { name: '', code: '' }] });
  }
  function updateColor(i, patch) {
    set({
      colors: draft.colors.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    });
  }
  function removeColor(i) {
    set({ colors: draft.colors.filter((_, idx) => idx !== i) });
  }
  function moveColor(from, to) {
    if (from == null || to == null || from === to) return;
    const next = [...(draft.colors || [])];
    const [moved] = next.splice(from, 1);
    // Indicator renders above the target, so insert before it; dragging
    // downward shifts indices down by one after the splice.
    next.splice(from < to ? to - 1 : to, 0, moved);
    set({ colors: next });
  }

  async function save() {
    if (!draft.name?.trim()) {
      setError('El nombre es obligatorio.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const now = Date.now();
      const row = {
        id: material?.id || newId(),
        profileId,
        category: draft.category,
        name: draft.name.trim(),
        grade: draft.grade?.trim() || null,
        wearRating: draft.wearRating?.trim() || null,
        wearDoubleRubs: draft.wearDoubleRubs ?? null,
        measure: draft.measure ?? null,
        measureUnit: draft.measureUnit || null,
        price: draft.price ?? null,
        priceUnit: draft.priceUnit || null,
        composition: draft.composition?.trim() || null,
        colors: (draft.colors || []).filter((c) => c.name?.trim() || c.code?.trim()),
        notes: draft.notes?.trim() || null,
        createdAt: material?.createdAt || now,
        updatedAt: now,
      };
      await db.materials.put(row);
      onClose();
    } catch (e) {
      setError(e?.message || 'No se pudo guardar.');
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? 'Nuevo material' : `Editar ${material.name}`}>
      <div className="space-y-4">
        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </div>
        )}

        {/* No separate material-level photo: the material's thumbnail is
            simply the first color that has one (see heroImageId). Add
            per-color swatches in the Colores section below. */}

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">Categoría</span>
            <select
              className="input"
              value={draft.category}
              onChange={(e) => {
                const cat = e.target.value;
                set({
                  category: cat,
                  measureUnit: cat === 'leather' ? 'mm' : 'in',
                  priceUnit: cat === 'leather' ? 'sm' : 'yard',
                });
              }}
            >
              <option value="fabric">Tela</option>
              <option value="leather">Piel</option>
              <option value="outdoor">Outdoor</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Nombre</span>
            <DebouncedInput
              className="input"
              value={draft.name}
              onCommit={(v) => set({ name: v })}
              autoCapitalize="characters"
            />
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">Grade</span>
            <select
              className="input"
              value={draft.grade || ''}
              onChange={(e) => set({ grade: e.target.value })}
            >
              <option value="">—</option>
              {GRADE_GROUPS.flatMap((g) => g.grades).map((g) => (
                <option key={g} value={g}>Grade {g}</option>
              ))}
              {SPECIAL_GRADES.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Wear</span>
            <DebouncedInput
              className="input"
              value={draft.wearRating || ''}
              onCommit={(v) => set({ wearRating: v })}
              placeholder="3C"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Double rubs</span>
            <DebouncedInput
              type="number"
              className="input tabular-nums"
              value={draft.wearDoubleRubs ?? ''}
              onCommit={(v) => set({ wearDoubleRubs: v === '' ? null : Number(v) })}
              placeholder="50000"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">{draft.category === 'leather' ? 'Grosor' : 'Ancho'}</span>
            <div className="flex gap-2">
              <DebouncedInput
                type="number"
                className="input tabular-nums flex-1"
                value={draft.measure ?? ''}
                onCommit={(v) => set({ measure: v === '' ? null : Number(v) })}
              />
              <select
                className="input w-20"
                value={draft.measureUnit || ''}
                onChange={(e) => set({ measureUnit: e.target.value })}
              >
                <option value="in">in</option>
                <option value="mm">mm</option>
              </select>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Precio</span>
            <div className="flex gap-2">
              <DebouncedInput
                type="number"
                className="input tabular-nums flex-1"
                value={draft.price ?? ''}
                onCommit={(v) => set({ price: v === '' ? null : Number(v) })}
              />
              <select
                className="input w-20"
                value={draft.priceUnit || ''}
                onChange={(e) => set({ priceUnit: e.target.value })}
              >
                <option value="yard">/ yd</option>
                <option value="sm">/ m²</option>
              </select>
            </div>
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="label">Composición</span>
          <DebouncedTextarea
            className="input min-h-[60px]"
            value={draft.composition || ''}
            onCommit={(v) => set({ composition: v })}
            placeholder="COTTON 80%, POLYESTER 20%"
          />
        </label>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="label">Colores ({draft.colors?.length || 0})</span>
            <button type="button" onClick={addColor} className="btn-ghost text-xs">
              <Plus size={12} /> Color
            </button>
          </div>
          <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
            {(draft.colors || []).map((c, i) => {
              const isDragging = dragColor === i;
              const isDropTarget = dropColor === i && dragColor !== i;
              return (
              <div
                key={i}
                onDragOver={(e) => {
                  if (dragColor == null || dragColor === i) return;
                  e.preventDefault();
                  setDropColor(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  moveColor(dragColor, i);
                  setDragColor(null);
                  setDropColor(null);
                }}
                className={`relative grid grid-cols-[auto_auto_1fr_120px_auto] gap-2 items-center ${isDragging ? 'opacity-40' : ''}`}
              >
                {isDropTarget && (
                  <div className="absolute left-0 right-0 -top-1 h-0.5 bg-brand-500 z-10 pointer-events-none" />
                )}
                {/* Drag handle — only the handle is draggable so the inputs
                    stay selectable/editable. Same affordance as the quote
                    line list. */}
                <span
                  draggable
                  onDragStart={(e) => {
                    setDragColor(i);
                    try { e.dataTransfer.effectAllowed = 'move'; } catch {}
                  }}
                  onDragEnd={() => { setDragColor(null); setDropColor(null); }}
                  className="cursor-grab text-ink-300 hover:text-ink-600 inline-flex items-center justify-center w-4"
                  title="Arrastra para reordenar"
                  aria-label="Reordenar color"
                >
                  <GripVertical size={14} />
                </span>
                {/* Tiny swatch thumbnail per color. Defaults to a
                    placeholder + camera glyph; clicking opens the
                    file picker exactly like the material-level
                    Thumbnail above. Per-color photos are aspirational
                    — 850 colors imported from LR start with null
                    imageId and the dealer attaches them as needed. */}
                <Thumbnail
                  imageId={c.imageId}
                  fallbackUrl={swatchUrl(c.code)}
                  onChange={(id) => updateColor(i, { imageId: id })}
                  kind="material-color"
                  ownerId={material?.id}
                  sizeClass="w-9 h-9"
                />
                <DebouncedInput
                  className="input py-1.5 text-sm"
                  value={c.name || ''}
                  onCommit={(v) => updateColor(i, { name: v })}
                  placeholder="Nombre"
                  autoCapitalize="characters"
                />
                <DebouncedInput
                  className="input py-1.5 text-sm font-mono tabular-nums"
                  value={c.code || ''}
                  onCommit={(v) => updateColor(i, { code: v })}
                  placeholder="Código"
                />
                <button
                  type="button"
                  onClick={() => removeColor(i)}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-ink-400 hover:text-red-600 hover:bg-red-50"
                  aria-label="Quitar color"
                >
                  <X size={13} />
                </button>
              </div>
              );
            })}
            {!(draft.colors || []).length && (
              <div className="text-xs text-ink-500 italic py-2">Sin colores.</div>
            )}
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="label">Notas</span>
          <DebouncedTextarea
            className="input min-h-[50px]"
            value={draft.notes || ''}
            onCommit={(v) => set({ notes: v })}
            placeholder="Advertencias, condiciones de uso…"
          />
        </label>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
          <button type="button" onClick={onClose} className="btn-ghost">Cancelar</button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="btn-primary"
          >
            {busy ? <><Loader2 size={14} className="animate-spin" /> Guardando…</> : <><Check size={14} /> Guardar</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}
