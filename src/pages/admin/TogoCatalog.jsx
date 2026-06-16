import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Sofa, Upload, Loader2, Trash2, Check, AlertCircle, Shield, Plus, Sparkles, Code2, Copy, ExternalLink } from 'lucide-react';
import { togoEmbedSnippet, togoEmbedUrl } from '../../lib/togoEmbed.js';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { groupFamilies } from '../../lib/catalog.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import { TOGO_SEEDS } from '../../assets/togo/seeds.js';

/**
 * Togo catalog admin — the dealer-managed picture catalog the configurator reads.
 * Upload a model's DWG → it's converted to a top-down plan IN THE BROWSER (the
 * libredwg WASM is lazy-loaded only here, on the first drop) → name it, bind it
 * to a Ligne Roset product for pricing, and save. Reliable because each model is
 * an explicit, dealer-authored entry — no name-matching guesswork.
 */
export default function TogoCatalog() {
  const { isAdmin, profileId } = useApp();
  const models = useLiveQuery(
    () => (profileId ? db.togoModels.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  const products = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  // Families for the "bind to product" select — Togo models first, then the rest.
  const families = useMemo(() => {
    const all = groupFamilies(products).filter((f) => f.name);
    const isTogo = (f) => /togo/i.test(f.name);
    return [...all.filter(isTogo), ...all.filter((f) => !isTogo(f))]
      .sort((a, b) => (isTogo(b) - isTogo(a)) || (a.name || '').localeCompare(b.name || ''));
  }, [products]);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Catálogo Togo" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar el catálogo Togo." />
      </>
    );
  }

  const sorted = [...(models || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''));

  // Best-effort: bind a seed to a "Togo …" catalog family by its keywords, so the
  // imported pieces are priced + fabric-enabled out of the box when the dealer
  // has Togo products. Unmatched seeds stay unbound (bind them by hand below).
  const togoFamilies = useMemo(() => families.filter((f) => /togo/i.test(f.name)), [families]);
  const autoRoot = (seed) => {
    const keys = (seed.match || []).filter((k) => k !== 'togo');
    const hit = togoFamilies.find((f) => { const n = (f.name || '').toLowerCase(); return keys.some((k) => k && n.includes(k)); });
    return hit ? hit.root : null;
  };

  const importSeeds = async () => {
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
  };

  return (
    <>
      <PageHeader title="Catálogo Togo" subtitle="Modelos del configurador · sube el DWG de cada pieza" />

      <AddModelCard families={families} profileId={profileId} nextSort={sorted.length ? Math.max(...sorted.map((m) => m.sortOrder || 0)) + 1 : 0} />

      {sorted.length > 0 && <EmbedCard />}

      <div className="mt-5">
        {sorted.length === 0 ? (
          <EmptyState
            icon={Sofa}
            title="Aún no hay modelos Togo"
            description="Sube el DWG de cada pieza arriba, o importa las cinco piezas de ejemplo para empezar."
            action={<button type="button" onClick={importSeeds} className="btn-primary text-sm"><Sparkles size={15} /> Importar piezas de ejemplo</button>}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {sorted.map((m) => (
              <ModelCard key={m.id} model={m} families={families} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** The upload + convert + bind form. */
function AddModelCard({ families, profileId, nextSort }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null); // { svg, widthCm, depthCm, warning }
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [saving, setSaving] = useState(false);

  const onFile = useCallback(async (file) => {
    if (!file) return;
    setError(null); setBusy(true); setPlan(null);
    if (!/\.dwg$/i.test(file.name)) { setError('El archivo debe ser un .dwg de AutoCAD.'); setBusy(false); return; }
    try {
      const buf = await file.arrayBuffer();
      // The 6 MB libredwg WASM loads lazily, only on the first real conversion.
      const mod = await safeDynamicImport(() => import('../../lib/togo/dwgToPlan.js'));
      const res = await mod.dwgToPlan(buf);
      if (!res.svg || res.warning === 'no-geometry') {
        setError('No se encontró geometría de planta en el DWG (capa “Mobilier 2D”).');
      } else {
        setPlan(res);
        if (!name) setName(file.name.replace(/\.dwg$/i, '').replace(/[_-]+/g, ' ').trim());
      }
    } catch (e) {
      console.error('[togo] dwg conversion failed', e);
      setError('No se pudo leer el DWG. ¿Es un AutoCAD 2013+ válido?');
    } finally {
      setBusy(false);
    }
  }, [name]);

  const save = async () => {
    if (!plan || !name.trim() || saving) return;
    setSaving(true);
    try {
      await db.togoModels.put({
        id: newId(), profileId, name: name.trim(),
        productRoot: root || null, productReference: null,
        widthCm: plan.widthCm, depthCm: plan.depthCm, svg: plan.svg,
        sortOrder: nextSort, active: true, createdAt: Date.now(), updatedAt: Date.now(),
      });
      setPlan(null); setName(''); setRoot('');
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
        <input ref={fileRef} type="file" accept=".dwg" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        {busy ? (
          <span className="inline-flex items-center gap-2 text-sm text-ink-500"><Loader2 size={16} className="animate-spin" /> Convirtiendo…</span>
        ) : (
          <span className="text-sm text-ink-500">Arrastra un <b>.dwg</b> aquí o haz clic para elegirlo</span>
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
            <div className="text-[11px] text-ink-500 tabular-nums">
              Huella detectada: <b className="text-ink-700">{plan.widthCm}×{plan.depthCm} cm</b>
              {plan.warning === 'fallback-layer' && <span className="text-amber-600"> · sin capa “Mobilier 2D”, se usó otra capa 2D</span>}
            </div>
            <div>
              <label className="label">Nombre</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Sillón Togo" />
            </div>
            <div>
              <label className="label">Producto (precio por grado)</label>
              <select className="input" value={root} onChange={(e) => setRoot(e.target.value)}>
                <option value="">Sin vincular (precio manual en el configurador)</option>
                {families.map((f) => (
                  <option key={f.root} value={f.root}>{f.name}{f.graded ? ` · ${f.grades.length} grados` : ''}</option>
                ))}
              </select>
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

/** One saved model — thumbnail, footprint, editable name + product binding, delete. */
function ModelCard({ model, families }) {
  // Optimistic binding: the global invalidate refetches the whole (huge) products
  // catalog, so a live refetch can lag ~seconds. Show the dealer's choice INSTANTLY
  // and clear the optimistic value only once the persisted row catches up.
  const [pending, setPending] = useState(null);
  const value = pending != null ? pending : (model.productRoot || '');
  useEffect(() => {
    if (pending != null && (model.productRoot || '') === pending) setPending(null);
  }, [model.productRoot, pending]);
  const bind = async (val) => {
    setPending(val);
    try { await db.togoModels.update(model.id, { productRoot: val || null, updatedAt: Date.now() }); }
    catch { setPending(null); }
  };
  const boundFamily = families.find((f) => f.root === value) || null;
  return (
    <div className="card card-pad space-y-2.5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-16 h-16 rounded-lg bg-ink-50 text-ink-700 p-1 grid place-items-center" dangerouslySetInnerHTML={{ __html: model.svg }} />
        <div className="flex-1 min-w-0">
          <input
            className="input h-8 py-0 text-[13px] font-medium"
            defaultValue={model.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== model.name && db.togoModels.update(model.id, { name: e.target.value.trim(), updatedAt: Date.now() })}
          />
          <div className="text-[11px] text-ink-500 tabular-nums mt-1">{model.widthCm}×{model.depthCm} cm</div>
        </div>
        <button type="button" onClick={() => db.togoModels.delete(model.id)} className="text-ink-400 hover:text-red-600 p-1" title="Eliminar modelo">
          <Trash2 size={15} />
        </button>
      </div>
      <select className="input h-8 py-0 text-[11px]" value={value} onChange={(e) => bind(e.target.value)}>
        <option value="">Sin vincular (precio manual)</option>
        {families.map((f) => (
          <option key={f.root} value={f.root}>{f.name}{f.graded ? ` · ${f.grades.length} grados` : ''}</option>
        ))}
      </select>
      {value
        ? <div className="text-[10px] text-emerald-600 inline-flex items-center gap-1"><Check size={11} /> Vinculado{boundFamily?.graded ? ` · precio por grado (${boundFamily.grades.length})` : ''}{pending != null ? ' · guardando…' : ''}</div>
        : <div className="text-[10px] text-ink-400">Sin vincular · el configurador no podrá poner precio por tela</div>}
    </div>
  );
}
