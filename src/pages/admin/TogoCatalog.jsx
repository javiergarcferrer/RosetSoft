import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Sofa, Upload, UploadCloud, Loader2, Trash2, Check, AlertCircle, Shield, Sparkles, Code2, Copy, ExternalLink, Link2, Box, RefreshCw } from 'lucide-react';
import { togoEmbedSnippet, togoEmbedUrl } from '../../lib/togoEmbed.js';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { uploadTogoMesh, removeTogoMesh } from '../../db/togoMeshUpload.js';
import { loadMeshPlan } from '../../lib/togo/meshPlanCache.js';
import { groupFamilies } from '../../lib/catalog.js';
import { resolveTogoModelCards, togoPickerFamilies } from '../../core/quote/index.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import EmptyState from '../../components/EmptyState.jsx';
import { TOGO_SEEDS } from '../../assets/togo/seeds.js';

/**
 * The "Modelos" tab of the Togo workspace (TogoWorkspace) — the dealer-managed
 * picture catalog the configurator reads, plus the website embed snippet. Upload
 * a model's DWG → it's converted to a top-down plan IN THE BROWSER (the libredwg
 * WASM is lazy-loaded only here, on the first drop) → name it, bind it to a Ligne
 * Roset product for pricing, and save. Reliable because each model is an explicit,
 * dealer-authored entry — no name-matching guesswork. Renders no page chrome of
 * its own (the workspace owns the header + tabs); admin-only.
 *
 * Architecture: a model's BOUND state is a property of its own row (productRoot),
 * so the list renders instantly from the tiny togo_models query. The full LR
 * products catalog (thousands of SKUs) is a LAZY dependency — loaded only when the
 * dealer actually opens a picker to bind/rebind (or adds/imports). Visiting the
 * tab with everything already bound never pays the multi-second catalog load.
 */
export default function TogoModels() {
  const { isAdmin, profileId } = useApp();
  const models = useLiveQuery(
    () => (profileId ? db.togoModels.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );

  // The LR catalog is fetched ONLY once a binding UI asks for it. Until then the
  // query resolves null (cheap) and bound state comes from each model's row.
  const [needCatalog, setNeedCatalog] = useState(false);
  const requestCatalog = useCallback(() => setNeedCatalog(true), []);
  const products = useLiveQuery(
    () => (needCatalog && profileId
      ? db.products.where('profileId').equals(profileId).toArray()
      : Promise.resolve(null)),
    [profileId, needCatalog], null,
  );
  const catalogLoading = needCatalog && products === null;
  const families = useMemo(() => togoPickerFamilies(products), [products]);
  const cards = useMemo(() => resolveTogoModelCards(models, families), [models, families]);

  const importSeeds = useCallback(async () => {
    // One-off direct fetch so seed auto-binding works without making the whole
    // tab eagerly load the catalog (this only runs from the empty state).
    const prods = await db.products.where('profileId').equals(profileId).toArray();
    const togoFams = groupFamilies(prods).filter((f) => /togo/i.test(f.name || ''));
    const autoRoot = (seed) => {
      const keys = (seed.match || []).filter((k) => k !== 'togo');
      const hit = togoFams.find((f) => { const n = (f.name || '').toLowerCase(); return keys.some((k) => k && n.includes(k)); });
      return hit ? hit.root : null;
    };
    const existing = new Set((models || []).map((m) => (m.name || '').toLowerCase()));
    const base = models?.length ? Math.max(...models.map((m) => m.sortOrder || 0)) + 1 : 0;
    let i = 0;
    for (const s of TOGO_SEEDS) {
      if (existing.has(s.name.toLowerCase())) continue;
      await db.togoModels.put({
        id: newId(), profileId, name: s.name, productRoot: autoRoot(s), productReference: null,
        widthCm: s.widthCm, depthCm: s.depthCm, svg: s.svg, sortOrder: base + i++,
        active: true, createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
  }, [models, profileId]);

  if (!isAdmin) {
    return <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar el catálogo Togo." />;
  }

  const nextSort = cards.length ? Math.max(...cards.map((c) => c.sortOrder || 0)) + 1 : 0;

  return (
    <>
      <AddModelCard
        families={families}
        catalogLoading={catalogLoading}
        onNeedCatalog={requestCatalog}
        profileId={profileId}
        nextSort={nextSort}
      />

      {cards.length > 0 && <EmbedCard />}

      <div className="mt-5">
        {cards.length === 0 ? (
          <EmptyState
            icon={Sofa}
            title="Aún no hay modelos Togo"
            description="Sube el DWG de cada pieza arriba, o importa las cinco piezas de ejemplo para empezar."
            action={<button type="button" onClick={importSeeds} className="btn-primary text-sm"><Sparkles size={15} /> Importar piezas de ejemplo</button>}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {cards.map((c) => (
              <ModelCard key={c.id} card={c} families={families} catalogLoading={catalogLoading} onNeedCatalog={requestCatalog} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** The upload + convert + bind form. */
function AddModelCard({ families, catalogLoading, onNeedCatalog, profileId, nextSort }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null); // { svg, widthCm, depthCm, warning }
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [saving, setSaving] = useState(false);
  const [meshUrl, setMeshUrl] = useState(null);   // set when the source is a 3D model
  const [upAxis, setUpAxis] = useState('y');

  const onFile = useCallback(async (file) => {
    if (!file) return;
    setError(null); setBusy(true); setPlan(null);
    setMeshUrl((prev) => { if (prev) removeTogoMesh(prev); return null; });   // drop an orphan from a re-pick
    const is3d = /\.(fbx|glb|gltf|obj|dae|3ds)$/i.test(file.name);
    const isDwg = /\.dwg$/i.test(file.name);
    if (!is3d && !isDwg) { setError('Sube un modelo 3D (.fbx, .glb…) o un .dwg de AutoCAD.'); setBusy(false); return; }
    try {
      if (is3d) {
        // FBX-first: upload the mesh and derive BOTH the plan and the footprint
        // straight from it — one source for the 2D tile and the 3D view.
        const url = await uploadTogoMesh(file);
        const p = await loadMeshPlan(url, { upAxis: 'y' });
        setMeshUrl(url); setUpAxis('y'); setPlan(p);
        onNeedCatalog();
        if (!name) setName(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim());
      } else {
        const buf = await file.arrayBuffer();
        // The 6 MB libredwg WASM loads lazily, only on a real DWG conversion.
        const mod = await safeDynamicImport(() => import('../../lib/togo/dwgToPlan.js'));
        const res = await mod.dwgToPlan(buf);
        if (!res.svg || res.warning === 'no-geometry') {
          setError('No se encontró geometría de planta en el DWG (capa “Mobilier 2D”).');
        } else {
          setPlan(res);
          onNeedCatalog();
          if (!name) setName(file.name.replace(/\.dwg$/i, '').replace(/[_-]+/g, ' ').trim());
        }
      }
    } catch (e) {
      console.error('[togo] model conversion failed', e);
      setError(is3d ? 'No se pudo leer el modelo 3D.' : 'No se pudo leer el DWG. ¿Es un AutoCAD 2013+ válido?');
    } finally {
      setBusy(false);
    }
  }, [name, onNeedCatalog]);

  // The mesh sometimes exports lying on its side; flip the vertical axis and
  // re-derive the plan from the same upload.
  const flipAxis = async () => {
    if (!meshUrl || busy) return;
    const next = upAxis === 'z' ? 'y' : 'z';
    setBusy(true);
    try { const p = await loadMeshPlan(meshUrl, { upAxis: next }); setUpAxis(next); setPlan(p); }
    catch { /* keep current */ } finally { setBusy(false); }
  };

  const save = async () => {
    if (!plan || !name.trim() || saving) return;
    setSaving(true);
    try {
      await db.togoModels.put({
        id: newId(), profileId, name: name.trim(),
        productRoot: root || null, productReference: null,
        widthCm: plan.widthCm, depthCm: plan.depthCm, svg: plan.svg,
        meshUrl: meshUrl || null, meshUpAxis: meshUrl ? upAxis : null, meshScale: null, meshRotateY: 0,
        sortOrder: nextSort, active: true, createdAt: Date.now(), updatedAt: Date.now(),
      });
      setPlan(null); setName(''); setRoot(''); setMeshUrl(null); setUpAxis('y');
      if (fileRef.current) fileRef.current.value = '';
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-pad space-y-4">
      <h2 className="font-display font-semibold text-sm flex items-center gap-2"><Upload size={15} className="text-brand-500" /> Agregar modelo</h2>

      <div
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
        onClick={() => fileRef.current?.click()}
        className="rounded-xl border-2 border-dashed border-ink-200 hover:border-brand-300 hover:bg-brand-50/40 transition-colors px-4 py-8 text-center cursor-pointer"
      >
        <input ref={fileRef} type="file" accept=".fbx,.glb,.gltf,.obj,.dae,.3ds,.dwg" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        {busy ? (
          <span className="inline-flex items-center gap-2 text-sm text-ink-500"><Loader2 size={16} className="animate-spin" /> Procesando…</span>
        ) : (
          <span className="text-sm text-ink-500">Arrastra un <b>modelo 3D (.fbx)</b> aquí o haz clic para elegirlo<br /><span className="text-[11px] text-ink-400">El plano 2D y la huella se generan del modelo. (También acepta .dwg)</span></span>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {error}
        </div>
      )}

      {plan && (
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="shrink-0 w-32 h-32 rounded-lg bg-ink-50 text-ink-700 p-2 grid place-items-center" dangerouslySetInnerHTML={{ __html: plan.svg }} />
          <div className="flex-1 space-y-2.5 min-w-0">
            <div className="text-[11px] text-ink-500 tabular-nums flex items-center gap-2 flex-wrap">
              <span>Huella detectada: <b className="text-ink-700">{plan.widthCm}×{plan.depthCm} cm</b></span>
              {meshUrl && <span className="text-emerald-600">· desde modelo 3D</span>}
              {meshUrl && (
                <button type="button" onClick={flipAxis} disabled={busy} className="btn-ghost text-[11px] py-0 h-6 disabled:opacity-50" title="Si el plano se ve girado, cambia el eje vertical">Eje {upAxis === 'z' ? 'Z' : 'Y'}</button>
              )}
              {plan.warning === 'fallback-layer' && <span className="text-amber-600"> · sin capa “Mobilier 2D”, se usó otra capa 2D</span>}
            </div>
            <div>
              <label className="label">Nombre</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Sillón Togo" />
            </div>
            <div>
              <label className="label">Producto (precio por grado)</label>
              {catalogLoading ? (
                <div className="input flex items-center gap-1.5 text-ink-400"><Loader2 size={14} className="animate-spin" /> Cargando catálogo…</div>
              ) : (
                <select className="input" value={root} onChange={(e) => setRoot(e.target.value)}>
                  <option value="">Sin vincular (precio manual en el configurador)</option>
                  {families.map((f) => (
                    <option key={f.root} value={f.root}>{f.name}{f.graded ? ` · ${f.grades.length} grados` : ''}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={save} disabled={!name.trim() || saving} className="btn-primary text-sm disabled:opacity-50">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar modelo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The website embed snippet + a link to the public widget. */
function EmbedCard() {
  const [copied, setCopied] = useState(false);
  const snippet = togoEmbedSnippet();
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div className="card card-pad mt-4 space-y-2.5">
      <h2 className="font-display font-semibold text-sm flex items-center gap-2"><Code2 size={15} className="text-brand-500" /> Embeber en tu web</h2>
      <p className="text-[11px] text-ink-500">Pega este código en tu sitio: los clientes arman su Togo y te llega como cotización borrador para dar seguimiento.</p>
      <div className="rounded-lg bg-ink-900 text-ink-100 text-[11px] font-mono p-3 overflow-x-auto whitespace-pre-wrap break-all">{snippet}</div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={copy} className="btn-ghost text-xs">{copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />} {copied ? 'Copiado' : 'Copiar código'}</button>
        <a href={togoEmbedUrl()} target="_blank" rel="noreferrer" className="btn-ghost text-xs"><ExternalLink size={14} /> Abrir vista pública</a>
      </div>
    </div>
  );
}

/**
 * One saved model — thumbnail, footprint, editable name + product binding, delete.
 * Bound state shows INSTANTLY from the row (card.bound); the family picker only
 * mounts (and the catalog only loads) when the dealer opens it to bind/rebind.
 */
function ModelCard({ card, families, catalogLoading, onNeedCatalog }) {
  const [editing, setEditing] = useState(false);
  // Optimistic binding: a global invalidate refetches the (huge) catalog, so the
  // persisted row can lag ~seconds. Show the dealer's choice INSTANTLY and clear
  // the optimistic value only once the row catches up.
  const [pending, setPending] = useState(null);
  const value = pending != null ? pending : (card.productRoot || '');
  useEffect(() => {
    if (pending != null && (card.productRoot || '') === pending) setPending(null);
  }, [card.productRoot, pending]);

  // Real 3D model upload (overrides the procedural geometry in the configurator).
  const [meshBusy, setMeshBusy] = useState(false);
  const [meshErr, setMeshErr] = useState(null);
  const onMeshFile = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setMeshBusy(true); setMeshErr(null);
    try {
      const prev = card.meshUrl;
      const url = await uploadTogoMesh(file);
      const upAxis = card.meshUpAxis || 'y';
      const plan = await loadMeshPlan(url, { upAxis });   // the FBX is the plan + footprint source
      await db.togoModels.update(card.id, {
        meshUrl: url, meshScale: null, meshUpAxis: upAxis, meshRotateY: card.meshRotateY || 0,
        ...(plan?.svg ? { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm } : {}),
        updatedAt: Date.now(),
      });
      if (prev) removeTogoMesh(prev);
    } catch (err) { setMeshErr(err?.message || 'No se pudo subir el modelo 3D.'); }
    finally { setMeshBusy(false); }
  };
  const removeMesh = async () => {
    const prev = card.meshUrl;
    await db.togoModels.update(card.id, { meshUrl: null, updatedAt: Date.now() });
    if (prev) removeTogoMesh(prev);
  };
  // Flipping the vertical axis changes which plane is the floor → re-derive the plan.
  const toggleAxis = async () => {
    if (!card.meshUrl || meshBusy) return;
    const next = card.meshUpAxis === 'z' ? 'y' : 'z';
    setMeshBusy(true); setMeshErr(null);
    try {
      const plan = await loadMeshPlan(card.meshUrl, { upAxis: next });
      await db.togoModels.update(card.id, { meshUpAxis: next, ...(plan?.svg ? { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm } : {}), updatedAt: Date.now() });
    } catch (err) { setMeshErr(err?.message || 'No se pudo regenerar.'); } finally { setMeshBusy(false); }
  };
  // Refresh the stored 2D plan + footprint from the current mesh (one click for the
  // models uploaded before the plan was mesh-derived).
  const regenPlan = async () => {
    if (!card.meshUrl || meshBusy) return;
    setMeshBusy(true); setMeshErr(null);
    try {
      const plan = await loadMeshPlan(card.meshUrl, { upAxis: card.meshUpAxis || 'y' });
      if (plan?.svg) await db.togoModels.update(card.id, { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm, updatedAt: Date.now() });
      else setMeshErr('El modelo no produjo una planta.');
    } catch (err) { setMeshErr(err?.message || 'No se pudo regenerar la planta.'); } finally { setMeshBusy(false); }
  };
  const ACCEPT_3D = '.fbx,.glb,.gltf,.obj,.dae,.3ds';

  const openPicker = () => { onNeedCatalog(); setEditing(true); };
  const bind = async (val) => {
    setPending(val);
    setEditing(false);
    try { await db.togoModels.update(card.id, { productRoot: val || null, updatedAt: Date.now() }); }
    catch { setPending(null); }
  };

  const bound = !!value;
  // Enrichment (family name + grade count) only once the catalog is loaded; the
  // optimistic `pending` may point at a root we can already resolve in `families`.
  const boundFamily = families.find((f) => f.root === value) || null;

  return (
    <div className="card card-pad space-y-2.5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-16 h-16 rounded-lg bg-ink-50 text-ink-700 p-1 grid place-items-center" dangerouslySetInnerHTML={{ __html: card.svg }} />
        <div className="flex-1 min-w-0">
          <input
            className="input h-8 py-0 text-[13px] font-medium"
            defaultValue={card.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== card.name && db.togoModels.update(card.id, { name: e.target.value.trim(), updatedAt: Date.now() })}
          />
          <div className="text-[11px] text-ink-500 tabular-nums mt-1">{card.widthCm}×{card.depthCm} cm</div>
        </div>
        <button type="button" onClick={() => db.togoModels.delete(card.id)} className="text-ink-400 hover:text-red-600 p-1" title="Eliminar modelo">
          <Trash2 size={15} />
        </button>
      </div>

      {editing ? (
        catalogLoading ? (
          <div className="h-8 inline-flex items-center gap-1.5 text-[11px] text-ink-400"><Loader2 size={12} className="animate-spin" /> Cargando catálogo…</div>
        ) : (
          <select
            className="input h-8 py-0 text-[11px]"
            value={value}
            autoFocus
            onChange={(e) => bind(e.target.value)}
            onBlur={() => setEditing(false)}
          >
            <option value="">Sin vincular (precio manual)</option>
            {families.map((f) => (
              <option key={f.root} value={f.root}>{f.name}{f.graded ? ` · ${f.grades.length} grados` : ''}</option>
            ))}
          </select>
        )
      ) : (
        <div className="flex items-center justify-between gap-2">
          {bound ? (
            <span className="min-w-0 text-[10px] text-emerald-600 inline-flex items-center gap-1">
              <Check size={11} className="shrink-0" />
              <span className="truncate">
                Vinculado{boundFamily ? ` · ${boundFamily.name}` : ''}{boundFamily?.graded ? ` (${boundFamily.grades.length} grados)` : ''}
              </span>
              {pending != null && <span className="text-ink-400 shrink-0"> · guardando…</span>}
            </span>
          ) : (
            <span className="text-[10px] text-ink-400">Sin vincular · sin precio por tela</span>
          )}
          <button type="button" onClick={openPicker} className="btn-ghost text-[11px] shrink-0">
            <Link2 size={12} /> {bound ? 'Cambiar' : 'Vincular'}
          </button>
        </div>
      )}

      {/* Real 3D model — a pCon mesh export (FBX/GLB/…). When set, the
          configurator renders it instead of the procedural Togo. */}
      <div className="border-t border-ink-100 pt-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`min-w-0 text-[10px] inline-flex items-center gap-1 ${card.meshUrl ? 'text-emerald-600' : 'text-ink-400'}`}>
            <Box size={11} className="shrink-0" /> {card.meshUrl ? 'Modelo 3D cargado' : 'Geometría generada'}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {card.meshUrl && (
              <button type="button" onClick={regenPlan} disabled={meshBusy} className="btn-ghost text-[11px] disabled:opacity-50" title="Regenerar el plano 2D y la huella desde el modelo 3D"><RefreshCw size={12} /> Planta</button>
            )}
            {card.meshUrl && (
              <button type="button" onClick={toggleAxis} disabled={meshBusy} className="btn-ghost text-[11px] disabled:opacity-50" title="Si el modelo aparece acostado, cambia el eje vertical">Eje {card.meshUpAxis === 'z' ? 'Z' : 'Y'}</button>
            )}
            <label className="btn-ghost text-[11px] cursor-pointer">
              {meshBusy ? <Loader2 size={12} className="animate-spin" /> : <UploadCloud size={12} />} {card.meshUrl ? 'Reemplazar' : 'Subir 3D'}
              <input type="file" accept={ACCEPT_3D} className="hidden" onChange={onMeshFile} disabled={meshBusy} />
            </label>
            {card.meshUrl && (
              <button type="button" onClick={removeMesh} className="text-ink-400 hover:text-red-600 p-1" title="Quitar modelo 3D"><Trash2 size={13} /></button>
            )}
          </div>
        </div>
        {meshErr && <div className="text-[10px] text-red-600 inline-flex items-start gap-1"><AlertCircle size={11} className="mt-0.5 shrink-0" /> {meshErr}</div>}
      </div>
    </div>
  );
}
