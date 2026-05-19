import { useMemo, useState } from 'react';
import {
  Layers, Plus, Search, Pencil, Trash2, Shield, Download, Check,
  Loader2, X,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import Modal from '../../components/Modal.jsx';
import { DebouncedInput, DebouncedTextarea } from '../../components/DebouncedInput.jsx';
import { GRADE_GROUPS, SPECIAL_GRADES } from '../../lib/subtype.js';
import lrSeed from '../../data/lr-materials-2025-10.json';

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
  const [category, setCategory] = useState(''); // '' | 'fabric' | 'leather' | 'outdoor'
  const [editing, setEditing] = useState(null); // material being edited, or 'new'
  const [importBusy, setImportBusy] = useState(false);
  const [importDone, setImportDone] = useState(0);
  const [importError, setImportError] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return materials
      .filter((m) => (category ? m.category === category : true))
      .filter((m) => {
        if (!q) return true;
        if (m.name?.toLowerCase().includes(q)) return true;
        if (m.grade?.toLowerCase().includes(q)) return true;
        if (m.colors?.some((c) => c.name?.toLowerCase().includes(q) || c.code?.includes(q))) return true;
        return false;
      })
      .sort((a, b) => {
        const ca = a.category.localeCompare(b.category);
        if (ca) return ca;
        return (a.name || '').localeCompare(b.name || '');
      });
  }, [materials, search, category]);

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

  async function importSeed() {
    if (importBusy) return;
    setImportError(null);
    setImportBusy(true);
    setImportDone(0);
    try {
      // Dedupe against what's already loaded: skip any material whose
      // (category, name) already exists. The DB has a UNIQUE index on
      // (profile_id, category, lower(name)) so even if the dedupe slip
      // we'd surface a clean error rather than silently duplicate.
      const existing = new Set(
        materials.map((m) => `${m.category}::${(m.name || '').toLowerCase()}`),
      );
      const now = Date.now();
      const rows = lrSeed
        .filter((s) => !existing.has(`${s.category}::${(s.name || '').toLowerCase()}`))
        .map((s) => ({
          id: newId(),
          profileId,
          category: s.category,
          name: s.name,
          grade: s.grade || null,
          wearRating: s.wearRating || null,
          wearDoubleRubs: s.wearDoubleRubs ?? null,
          measure: s.measure ? parseMeasure(s.measure) : null,
          measureUnit: s.category === 'leather' ? 'mm' : 'in',
          price: typeof s.price === 'number' ? s.price : null,
          priceUnit: s.category === 'leather' ? 'sm' : 'yard',
          composition: s.composition || null,
          colors: Array.isArray(s.colors) ? s.colors : [],
          notes: s.notes || null,
          createdAt: now,
          updatedAt: now,
        }));

      // bulkPut chunks the writes and retries; surfaces the count via
      // the onProgress callback so the import button shows live
      // progress on the bigger insertions.
      await db.materials.bulkPut(rows, {
        chunkSize: 50,
        onProgress: (done) => setImportDone(done),
      });
    } catch (e) {
      setImportError(e?.message || 'No se pudo importar el catálogo.');
    } finally {
      setImportBusy(false);
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
              onClick={importSeed}
              disabled={importBusy}
              className="btn-ghost disabled:opacity-60 disabled:cursor-wait"
              title="Importar el catálogo Ligne Roset 10.2025 (USD) sin duplicar nada"
            >
              {importBusy
                ? <><Loader2 size={14} className="animate-spin" /> Importando… {importDone || ''}</>
                : <><Download size={14} /> Importar Ligne Roset 10.2025</>}
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

      {importError && (
        <div role="alert" className="card card-pad mb-4 text-sm text-red-700 bg-red-50 border-red-200">
          No se pudo importar: {importError}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            className="input pl-9"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, grade o color…"
          />
        </div>
        <div className="inline-flex rounded-md border border-ink-200 bg-white text-xs">
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
              className={`px-3 py-1.5 ${i > 0 ? 'border-l border-ink-200' : ''} ${
                category === c.k ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

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
                    <td className="px-3 py-2 text-[11px] uppercase tracking-wide text-ink-500">
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
                    <td colSpan={7} className="px-3 py-8 text-center text-sm text-ink-500">
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

function parseMeasure(raw) {
  // Width values in the LR price list include fractions like "54¼".
  // Coerce them into decimal so they sort and display sensibly.
  const s = String(raw).replace('¼', '.25').replace('½', '.5').replace('¾', '.75');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
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
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {(draft.colors || []).map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_auto] gap-2 items-center">
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
            ))}
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
