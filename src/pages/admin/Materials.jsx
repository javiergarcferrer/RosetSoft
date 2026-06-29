import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useState } from 'react';
import {
  Layers, Plus, Pencil, Trash2, Shield, Check,
  Loader2, X, GripVertical, AlertTriangle, FileText, RefreshCw,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { syncCatalog } from '../../lib/catalogSync.js';
import { mergeCatalog } from '../../lib/lrCatalog.js';
import { fetchLrPatterns, fetchLrPatternsOptional, ensureLrCron } from '../../lib/lrCatalogSync.js';
import { parsePriceListPdfs } from '../../lib/loadMaterialsPdf.js';
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
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import { GRADE_GROUPS, SPECIAL_GRADES } from '../../lib/subtype.js';

/**
 * Desktop table columns (Shopify-orders-style customizable list). ONE ordered
 * definition drives both the table render (`cell`) and the Columns menu
 * (`label` / `canHide`). `photo` is the fixed identity anchor (`canHide:
 * false`) — it's never hidden and isn't offered in the menu; everything else
 * the admin can toggle. Each `cell` is a pure render off the per-row `ctx`
 * the row assembles. The Editar/Eliminar actions stay a FIXED trailing cell
 * (they close over component handlers), outside this array.
 */
const MATERIAL_COLUMNS = [
  {
    key: 'photo', label: 'Foto', canHide: false, thClass: 'w-12',
    cell: ({ m }) => (
      <ImageView
        id={heroImageId(m)}
        fallbackUrl={heroSwatchUrl(m)}
        alt={m.name}
        hoverPreview
        className="w-10 h-10 object-cover rounded-lg border border-ink-100 bg-white shadow-xs"
        placeholderClassName="w-10 h-10 rounded-lg border border-dashed border-ink-200 bg-ink-50"
      />
    ),
  },
  {
    key: 'category', label: 'Categoría',
    tdClass: 'eyebrow font-normal tracking-wide text-ink-500',
    cell: ({ m }) => categoryLabel(m.category),
  },
  {
    key: 'name', label: 'Nombre',
    tdClass: 'font-medium text-ink-900',
    cell: ({ m }) => (
      <>
        {m.name}
        {m.discontinuedAt && (
          <span
            className="ml-2 chip bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-200 border border-amber-200 dark:border-amber-900/40 align-middle"
            title="Ya no se ofrece en el sitio de Ligne Roset"
          >
            <AlertTriangle size={10} /> No en sitio
          </span>
        )}
        {m.notInPricelistAt && (
          <span
            className="ml-2 chip bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-200 border border-red-200 dark:border-red-900/40 align-middle"
            title="No aparece en la lista de precios (PDF) de Ligne Roset"
          >
            <AlertTriangle size={10} /> No en lista
          </span>
        )}
      </>
    ),
  },
  {
    key: 'grade', label: 'Grade',
    cell: ({ m }) => <GradePill grade={m.grade} />,
  },
  {
    key: 'price', label: 'Precio (USD)',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ m }) => (m.price != null ? `$${m.price} / ${m.priceUnit === 'sm' ? 'm²' : 'yd'}` : '—'),
  },
  {
    key: 'measure', label: 'Medida',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ m }) => (m.measure != null ? `${m.measure} ${m.measureUnit || ''}` : '—'),
  },
  {
    key: 'colors', label: '# colores',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums text-ink-500',
    cell: ({ m }) => m.colors?.length || 0,
  },
];

// Default visibility for the hideable columns — the set the table shipped
// with (photo is always on). Persisted per-browser so an admin's column
// choice sticks across sessions; the _v1 suffix lets a future column set reset.
const MATERIAL_DEFAULT_COLS = {
  category: true, name: true, grade: true, price: true, measure: true, colors: true,
};
const MATERIAL_COLS_STORAGE_KEY = 'rs.materials.cols.v1';

/**
 * Materials catalog admin page.
 *
 * Manages the fabric / leather / outdoor catalog the quote builder
 * uses to auto-fill grade + color code on each line. Standalone CRUD
 * (table view + modal editor + delete) plus a live "Sincronizar con
 * Ligne Roset" import that reads any LR product page and merges the
 * fabrics + colors it offers into the catalog — non-destructively (see
 * lib/lrCatalog + the lr-catalog Edge Function).
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
  const [importing, setImporting] = useState(false); // PDF price-list import modal open?
  const [syncing, setSyncing] = useState(false);     // website-only sync modal open?
  const [confirmDelete, setConfirmDelete] = useState(null); // material pending delete confirm
  const [deleting, setDeleting] = useState(false);

  // Column visibility (Shopify "edit columns") — persisted per browser. The
  // table renders `cols` (photo anchor + the toggled-on columns, in order);
  // the Columns menu gets the full MATERIAL_COLUMNS so hidden ones can return.
  const {
    visible: visibleCols, setVisible: setVisibleCols, reset: resetCols, cols,
  } = useColumns(MATERIAL_COLUMNS, MATERIAL_DEFAULT_COLS, MATERIAL_COLS_STORAGE_KEY);
  // Drag-to-resize widths (persisted) for the same visible columns.
  const {
    tableRef, tableStyle, thProps, ResizeHandle, reset: resetWidths,
  } = useColumnWidths(cols, 'rs.materials.widths.v1');

  // Self-heal the weekly catalog-refresh cron (Mondays — pulls new/discontinued
  // fabrics + colors from ligne-roset.com unattended; see the lr-catalog Edge
  // Function + its migration). Admin-gated server-side and idempotent, so this
  // fire-and-forget on mount just guarantees the schedule exists — same pattern
  // as the Shopify LSG refresh + IG publisher crons.
  useEffect(() => {
    if (!isAdmin) return;
    ensureLrCron();
  }, [isAdmin]);

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

  async function confirmRemove() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await db.materials.delete(confirmDelete.id);
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
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
              onClick={() => setSyncing(true)}
              className="btn-ghost"
              title="Traer colores, fotos y telas nuevas desde ligne-roset.com (sin PDF)"
            >
              <RefreshCw size={14} /> Sincronizar
            </button>
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="btn-ghost"
              title="Subir la lista de precios (PDF) de Ligne Roset"
            >
              <FileText size={14} /> Importar precios
            </button>
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
        columns={MATERIAL_COLUMNS}
        visibleColumns={visibleCols}
        onColumnsChange={setVisibleCols}
        onColumnsReset={() => { resetCols(); resetWidths(); }}
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
        <>
        {/* Mobile: one card per material (same fields + actions as the table). */}
        <div className="md:hidden space-y-2">
          {filtered.map((m) => (
            <div key={m.id} className="card card-pad flex gap-3">
              <ImageView
                id={heroImageId(m)}
                fallbackUrl={heroSwatchUrl(m)}
                alt={m.name}
                className="w-12 h-12 object-cover rounded-lg border border-ink-100 bg-white shadow-xs shrink-0"
                placeholderClassName="w-12 h-12 rounded-lg border border-dashed border-ink-200 bg-ink-50 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink-900 truncate">{m.name}</span>
                  <span className="text-sm tabular-nums shrink-0">
                    {m.price != null ? `$${m.price} / ${m.priceUnit === 'sm' ? 'm²' : 'yd'}` : '—'}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-xs text-ink-500">
                  <span className="eyebrow font-normal tracking-wide">{categoryLabel(m.category)}</span>
                  <GradePill grade={m.grade} />
                  <span className="tabular-nums">{m.colors?.length || 0} colores</span>
                  {m.discontinuedAt && (
                    <span className="chip bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-200 border border-amber-200 dark:border-amber-900/40"><AlertTriangle size={10} /> No en sitio</span>
                  )}
                  {m.notInPricelistAt && (
                    <span className="chip bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-200 border border-red-200 dark:border-red-900/40"><AlertTriangle size={10} /> No en lista</span>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <button type="button" onClick={() => setEditing(m)} className="btn-ghost text-xs" title="Editar">
                    <Pencil size={14} /> Editar
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(m)} className="btn-icon-danger"
                    title="Eliminar" aria-label={`Eliminar ${m.name}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="card card-pad text-center text-sm text-ink-400">Sin resultados.</p>
          )}
        </div>
        <div className="hidden md:block card overflow-hidden">
          <div className="overflow-x-auto">
            <table ref={tableRef} style={tableStyle} className="table">
              <thead>
                <tr>
                  {cols.map((col) => (
                    <th key={col.key} className={col.thClass || ''} {...thProps(col.key)}>
                      {col.label}
                      {ResizeHandle(col.key)}
                    </th>
                  ))}
                  <th className="w-px" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr key={m.id} className="hover:bg-ink-50 transition-colors">
                    {cols.map((col) => (
                      <td key={col.key} className={col.tdClass || ''}>{col.cell({ m })}</td>
                    ))}
                    <td className="text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setEditing(m)}
                        className="btn-ghost text-xs"
                        title="Editar"
                      >
                        <Pencil size={14} /> Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(m)}
                        className="btn-icon-danger"
                        title="Eliminar"
                        aria-label={`Eliminar ${m.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={cols.length + 1} className="px-3 py-10 text-center text-sm text-ink-400">
                      Sin resultados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      {editing && (
        <MaterialEditor
          material={editing === 'new' ? null : editing}
          profileId={profileId}
          onClose={() => setEditing(null)}
        />
      )}

      {importing && (
        <ImportCatalogModal
          materials={materials}
          profileId={profileId}
          onClose={() => setImporting(false)}
        />
      )}

      {syncing && (
        <SyncWebsiteModal
          materials={materials}
          profileId={profileId}
          onClose={() => setSyncing(false)}
        />
      )}

      {confirmDelete && (
        <Modal open onClose={() => !deleting && setConfirmDelete(null)} title="Eliminar material">
          <div className="space-y-4">
            <p className="text-sm text-ink-600">
              ¿Eliminar <span className="font-medium text-ink-900">“{confirmDelete.name}”</span> del catálogo? Esta acción no se puede deshacer.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
              <button type="button" onClick={() => setConfirmDelete(null)} className="btn-ghost" disabled={deleting}>Cancelar</button>
              <button type="button" onClick={confirmRemove} className="btn-danger" disabled={deleting}>
                {deleting ? <><Loader2 size={14} className="animate-spin" /> Eliminando…</> : <><Trash2 size={14} /> Eliminar</>}
              </button>
            </div>
          </div>
        </Modal>
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
    <span className="chip bg-brand-50 text-brand-700 border border-brand-100">
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
      setError(userMessageFor(e));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? 'Nuevo material' : `Editar ${material.name}`}>
      <div className="space-y-4">
        {error && (
          <div role="alert" className="text-sm text-red-700 dark:text-red-200 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/40 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {/* No separate material-level photo: the material's thumbnail is
            simply the first color that has one (see heroImageId). Add
            per-color swatches in the Colores section below. */}

        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3">
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

        <div className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-3">
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
              inputMode="numeric"
              className="input tabular-nums"
              value={draft.wearDoubleRubs ?? ''}
              onCommit={(v) => set({ wearDoubleRubs: v === '' ? null : Number(v) })}
              placeholder="50000"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">{draft.category === 'leather' ? 'Grosor' : 'Ancho'}</span>
            <div className="flex gap-2">
              <DebouncedInput
                type="number"
                inputMode="decimal"
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
                inputMode="decimal"
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
                className={`relative flex flex-wrap items-center gap-2 ${isDragging ? 'opacity-40' : ''}`}
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
                  className="input py-1.5 text-sm flex-1 min-w-[90px]"
                  value={c.name || ''}
                  onCommit={(v) => updateColor(i, { name: v })}
                  placeholder="Nombre"
                  autoCapitalize="characters"
                />
                <DebouncedInput
                  className="input py-1.5 text-sm font-mono tabular-nums w-24 flex-shrink-0"
                  value={c.code || ''}
                  onCommit={(v) => updateColor(i, { code: v })}
                  placeholder="Código"
                />
                <button
                  type="button"
                  onClick={() => removeColor(i)}
                  className="btn-icon-danger"
                  aria-label="Quitar color"
                >
                  <X size={14} />
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

/* -------------------------------------------------------------------------- */
/*  Catalog import — PDF price list + automatic website sync                  */
/* -------------------------------------------------------------------------- */

/**
 * The single catalog-update flow. The dealer uploads the Ligne Roset price-list
 * PDF(s); we parse them (grade / price / width / composition / category) AND
 * sync colors + photos from ligne-roset.com in the same pass, merging both into
 * one set of changes (lib/catalogSync) with a preview before anything is
 * written. No separate sync button, no per-product URL — the PDF drives it.
 */
function ImportCatalogModal({ materials, profileId, onClose }) {
  const [files, setFiles] = useState([]);
  const [complete, setComplete] = useState(true);
  const [busy, setBusy] = useState(null);       // null | 'analyze' | 'apply'
  const [step, setStep] = useState('');          // progress label while analyzing
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);  // { rows, deleteIds, summary, siteFailed }
  const [done, setDone] = useState(null);

  async function analyze() {
    if (!files.length) { setError('Elige al menos un PDF de lista de precios.'); return; }
    setError(null);
    setBusy('analyze');
    try {
      // 1) Price-list PDF (required).
      setStep('Leyendo el PDF…');
      const parsed = await parsePriceListPdfs(files);
      if (!parsed.length) {
        throw new Error('No se reconocieron telas en el PDF. ¿Es la lista de materiales de Ligne Roset?');
      }

      // 2) Website colors/photos — best-effort; the import still works without it.
      setStep('Sincronizando colores con Ligne Roset… (~1 min)');
      const site = await fetchLrPatternsOptional();
      const sitePatterns = site?.patterns ?? null;
      const siteComplete = site?.complete ?? true;
      const siteFailed = !site;

      // 3) Stack both into one set of writes + deletes.
      setStep('Combinando el catálogo…');
      const { rows, deleteIds, summary } = syncCatalog(materials, sitePatterns, parsed, {
        profileId, now: Date.now(), newId, complete, siteComplete,
      });
      setPreview({ rows, deleteIds, summary, siteFailed });
    } catch (e) {
      setError(userMessageFor(e));
    } finally {
      setBusy(null);
      setStep('');
    }
  }

  async function apply() {
    if (!preview) return;
    setError(null);
    setBusy('apply');
    try {
      // Delete consolidated duplicates FIRST: a material moving category (e.g.
      // a fabric the PDF lists under OUTDOOR) would otherwise transiently
      // collide on the (category, name) unique index during the upsert.
      if (preview.deleteIds.length) await db.materials.bulkDelete(preview.deleteIds);
      if (preview.rows.length) await db.materials.bulkPut(preview.rows);
      setDone(preview.summary);
    } catch (e) {
      setError(userMessageFor(e));
      setBusy(null);
    }
  }

  const changeCount = preview ? preview.rows.length + preview.deleteIds.length : 0;

  return (
    <Modal open onClose={onClose} title="Importar precios (PDF)">
      <div className="space-y-4">
        {error && (
          <div role="alert" className="text-sm text-red-700 dark:text-red-200 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/40 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {done ? (
          <>
            <div className="flex items-start gap-2 text-sm text-emerald-800 dark:text-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/40 rounded-md px-3 py-2">
              <Check size={16} className="flex-shrink-0 mt-0.5" />
              <span>Catálogo actualizado.</span>
            </div>
            <SyncSummaryList summary={done} />
            <div className="flex items-center justify-end pt-2 border-t border-ink-100">
              <button type="button" onClick={onClose} className="btn-primary"><Check size={14} /> Listo</button>
            </div>
          </>
        ) : preview ? (
          <>
            <p className="text-sm text-ink-600">
              {preview.summary.pdfCount} telas en el PDF
              {preview.summary.siteSynced
                ? <> · {preview.summary.siteCount} en el sitio de Ligne Roset</>
                : null}.
            </p>
            {preview.siteFailed && (
              <p className="text-xs text-amber-700 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/40 rounded-md px-2 py-1">
                No se pudo leer ligne-roset.com — se importan los precios del PDF, pero no se actualizaron colores ni fotos esta vez.
              </p>
            )}
            <SyncSummaryList summary={preview.summary} />
            {changeCount === 0 ? (
              <p className="text-sm text-ink-500 italic">El catálogo ya está al día — no hay cambios que aplicar.</p>
            ) : (
              <p className="text-xs text-ink-500">
                El PDF manda en grade, precio, ancho, composición y categoría; el sitio aporta colores y fotos. No se borra nada salvo duplicados “/FR” que se fusionan.
              </p>
            )}
            <div className="flex items-center justify-between pt-2 border-t border-ink-100">
              <button type="button" onClick={() => setPreview(null)} className="btn-ghost" disabled={!!busy}>Volver</button>
              <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} className="btn-ghost" disabled={!!busy}>Cancelar</button>
                <button type="button" onClick={apply} disabled={!!busy || changeCount === 0} className="btn-primary">
                  {busy === 'apply'
                    ? <><Loader2 size={14} className="animate-spin" /> Aplicando…</>
                    : <><Check size={14} /> Aplicar ({changeCount})</>}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-600">
              Sube la(s) lista(s) de precios de Ligne Roset en PDF. Leeremos grade, precio, ancho,
              composición y categoría, y sincronizaremos los colores y fotos desde el sitio automáticamente.
            </p>
            <label className="flex flex-col gap-1">
              <span className="label">Archivos PDF</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="input"
                onChange={(e) => setFiles(Array.from(e.target.files || []))}
              />
            </label>
            {files.length > 0 && (
              <ul className="text-xs text-ink-500 list-disc pl-5">
                {files.map((f, i) => (<li key={i}>{f.name}</li>))}
              </ul>
            )}
            <label className="flex items-start gap-2 text-sm text-ink-600">
              <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} className="mt-0.5" />
              <span>Es la lista completa — marcar las telas que no aparezcan como “no en lista”.</span>
            </label>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
              <button type="button" onClick={onClose} className="btn-ghost" disabled={!!busy}>Cancelar</button>
              <button type="button" onClick={analyze} disabled={!!busy || !files.length} className="btn-primary">
                {busy === 'analyze'
                  ? <><Loader2 size={14} className="animate-spin" /> {step || 'Procesando…'}</>
                  : <><FileText size={14} /> Analizar</>}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Website sync — colors / photos / fabrics from the site (no PDF)           */
/* -------------------------------------------------------------------------- */

/**
 * Sync the catalog straight from ligne-roset.com — no PDF required.
 *
 * This is the SAME website-only sweep + merge the weekly Monday cron runs
 * unattended (lr-catalog `runWeeklySync` → `mergeCatalog`), but triggered on
 * demand and shown as a preview before anything is written. The site owns
 * colors, photos, care notes, and which fabrics exist (new + discontinued);
 * grade / price / width / composition stay whatever the price-list PDF set —
 * `mergeCatalog` preserves them. Discontinuation is flagged (never deleted) and
 * ONLY on a COMPLETE sweep, exactly the cron's rule; a flagged fabric that
 * reappears on the site is un-flagged. The "Importar precios" PDF flow is still
 * how grade/price get updated — this just keeps colors and the fabric roster
 * current between those occasional price lists.
 */
function SyncWebsiteModal({ materials, profileId, onClose }) {
  const [busy, setBusy] = useState(null);        // null | 'sync' | 'apply'
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);  // { rows, summary, complete, siteCount }
  const [done, setDone] = useState(null);

  async function sync() {
    setError(null);
    setBusy('sync');
    try {
      // A partial sweep (we saw more fabrics than we could read) must NOT flag
      // a still-offered fabric as discontinued — same guard the cron uses.
      const { patterns, complete } = await fetchLrPatterns();
      const { rows, summary } = mergeCatalog(materials, patterns, {
        profileId, now: Date.now(), newId, complete,
      });
      setPreview({ rows, summary, complete, siteCount: patterns.length });
    } catch (e) {
      setError(userMessageFor(e));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview) return;
    setError(null);
    setBusy('apply');
    try {
      if (preview.rows.length) await db.materials.bulkPut(preview.rows);
      setDone(preview);
    } catch (e) {
      setError(userMessageFor(e));
      setBusy(null);
    }
  }

  const changeCount = preview ? preview.rows.length : 0;
  const summaryRows = (s) => [
    ['Telas nuevas', s.newMaterials],
    ['Telas actualizadas', s.updatedMaterials],
    ['Colores añadidos', s.newColors],
    ['Colores retirados', s.removedColors],
    ['Marcadas “no en sitio”', s.flaggedMissing],
    ['Reactivadas (de vuelta en el sitio)', s.restored],
  ];

  return (
    <Modal open onClose={onClose} title="Sincronizar con el sitio">
      <div className="space-y-4">
        {error && (
          <div role="alert" className="text-sm text-red-700 dark:text-red-200 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/40 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {done ? (
          <>
            <div className="flex items-start gap-2 text-sm text-emerald-800 dark:text-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/40 rounded-md px-3 py-2">
              <Check size={16} className="flex-shrink-0 mt-0.5" />
              <span>Catálogo sincronizado con ligne-roset.com.</span>
            </div>
            <SummaryRows rows={summaryRows(done.summary)} />
            <div className="flex items-center justify-end pt-2 border-t border-ink-100">
              <button type="button" onClick={onClose} className="btn-primary"><Check size={14} /> Listo</button>
            </div>
          </>
        ) : preview ? (
          <>
            <p className="text-sm text-ink-600">
              {preview.siteCount} telas en el sitio de Ligne Roset.
            </p>
            {!preview.complete && (
              <p className="text-xs text-amber-700 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/40 rounded-md px-2 py-1">
                Solo se pudo leer parte del catálogo esta vez — se añaden colores y telas nuevas, pero no se marcará ninguna como “no en sitio”.
              </p>
            )}
            <SummaryRows rows={summaryRows(preview.summary)} />
            {changeCount === 0 ? (
              <p className="text-sm text-ink-500 italic">El catálogo ya está al día con el sitio — no hay cambios que aplicar.</p>
            ) : (
              <p className="text-xs text-ink-500">
                El sitio aporta colores, fotos y telas nuevas; grade, precio, ancho y composición se conservan (los pone la lista de precios). No se borra nada — las telas retiradas solo se marcan “no en sitio”.
              </p>
            )}
            <div className="flex items-center justify-between pt-2 border-t border-ink-100">
              <button type="button" onClick={() => setPreview(null)} className="btn-ghost" disabled={!!busy}>Volver</button>
              <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} className="btn-ghost" disabled={!!busy}>Cancelar</button>
                <button type="button" onClick={apply} disabled={!!busy || changeCount === 0} className="btn-primary">
                  {busy === 'apply'
                    ? <><Loader2 size={14} className="animate-spin" /> Aplicando…</>
                    : <><Check size={14} /> Aplicar ({changeCount})</>}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-600">
              Trae los colores, fotos y telas nuevas directamente desde ligne-roset.com — sin subir ningún PDF.
              Verás un resumen de los cambios antes de aplicar nada.
            </p>
            <p className="text-xs text-ink-500">
              Es la misma sincronización que corre sola cada lunes; aquí puedes ejecutarla cuando quieras. La lectura del sitio tarda ~1 minuto.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
              <button type="button" onClick={onClose} className="btn-ghost" disabled={!!busy}>Cancelar</button>
              <button type="button" onClick={sync} disabled={!!busy} className="btn-primary">
                {busy === 'sync'
                  ? <><Loader2 size={14} className="animate-spin" /> Leyendo el sitio… (~1 min)</>
                  : <><RefreshCw size={14} /> Sincronizar ahora</>}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// Presentational tally shared by the PDF import and the website sync previews:
// `[label, count]` pairs, zero-count rows hidden, nothing rendered when empty.
function SummaryRows({ rows }) {
  const visible = rows.filter(([, n]) => n > 0);
  if (!visible.length) return null;
  return (
    <ul className="text-sm border border-ink-100 rounded-lg overflow-hidden divide-y divide-ink-100">
      {visible.map(([label, n]) => (
        <li key={label} className="flex items-center justify-between px-3 py-1.5">
          <span className="text-ink-600">{label}</span>
          <span className="tabular-nums font-semibold text-ink-900">{n}</span>
        </li>
      ))}
    </ul>
  );
}

function SyncSummaryList({ summary }) {
  return (
    <SummaryRows rows={[
      ['Telas nuevas', summary.newMaterials],
      ['Telas actualizadas', summary.updatedMaterials],
      ['Colores añadidos', summary.colorsAdded],
      ['Duplicados “/FR” fusionados', summary.consolidated],
      ['Marcadas “no en lista”', summary.flaggedNoList],
      ['Marcadas “no en sitio”', summary.flaggedNoSite],
    ]} />
  );
}
