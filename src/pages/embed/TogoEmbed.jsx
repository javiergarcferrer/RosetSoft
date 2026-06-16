import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Sofa, RotateCw, Trash2, Plus, Loader2, Eraser, ArrowRight, ArrowLeft, Check, AlertCircle, Palette, Layers, X, FileDown, Box, Square } from 'lucide-react';
import { formatMoney } from '../../lib/format.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import { productForGrade } from '../../lib/catalog.js';
import { composeSubtype, composeFabricLabel } from '../../lib/subtype.js';
import { downloadText } from '../../lib/csv.js';
import { fetchTogoCatalog, submitTogoRequest } from '../../lib/togoEmbed.js';
import {
  resolveConfigurator, resolvePlacement, snapPlacement, footprintOf, clampToPlan, PX_PER_CM,
  resolveTogoDxf, placementsFromPlaced, resolveTogoScene, scenePlacementsFromPlaced,
} from '../../core/quote/index.js';
import Modal from '../../components/Modal.jsx';
import MaterialColorPicker from '../../components/quote-builder/MaterialColorPicker.jsx';
import ImageView from '../../components/ImageView.jsx';
import TogoScene3D from '../../components/togo/TogoScene3D.jsx';

const SCALE = PX_PER_CM;

/**
 * PUBLIC, no-login Togo configurator — embedded in the dealer's website via an
 * <iframe>, and shown back IN the app (Togo workspace → Configurador tab) as a
 * live preview of exactly what's deployed. This is THE single configurator: a
 * visitor drags Togo pieces into a top-down plan, PICKS FABRICS (the same
 * MaterialColorPicker the internal quote editor uses, fed by public-safe catalog
 * data from `togo-embed`), sees the live retail total (DOP), and requests a
 * quote → a pending togo_request the dealer promotes. Reuses the SAME pure VM as
 * the rest of the app; it just feeds it data from the Edge Function instead of
 * the DB. Renders OUTSIDE the app shell (no AppContext/session) and is pinned
 * light, so it sits cleanly inside any page.
 */

// material + color → the { grade, fabric, code } shape a placement carries. Mirrors
// SwatchPicker.toPick; `code` lets us render the LR swatch (swatchUrl) with no DB.
function toPick(material, color) {
  return { grade: material.grade || '', fabric: composeFabricLabel(material, color), code: color?.code || '' };
}

// Rehydrate the per-model family JSON the Edge Function sends into the SAME
// CatalogFamily shape productForGrade expects (byGrade as a Map).
function familyFromJson(f) {
  if (!f || !f.root) return null;
  return {
    root: f.root, name: f.name || '', graded: !!f.graded, grades: f.grades || [],
    brand: 'ligne-roset', family: '',
    byGrade: new Map(Object.entries(f.byGrade || {})),
  };
}

export default function TogoEmbed() {
  const [cat, setCat] = useState({ status: 'loading', data: null, error: null });
  const [placed, setPlaced] = useState([]);
  const [selectedUid, setSelectedUid] = useState(null);
  const [step, setStep] = useState('build'); // 'build' | 'form' | 'done'
  const [matOpen, setMatOpen] = useState(false);
  const [matMode, setMatMode] = useState('one'); // 'one' (selected piece) | 'all'
  const [view, setView] = useState('2d');        // '2d' plan editor | '3d' preview

  useEffect(() => {
    let active = true;
    fetchTogoCatalog()
      .then((d) => { if (active) setCat({ status: 'ready', data: d, error: null }); })
      .catch((e) => { if (active) setCat({ status: 'error', data: null, error: e?.message || 'Error' }); });
    return () => { active = false; };
  }, []);

  const data = cat.data;
  const rates = data?.rates || { USD: 1, DOP: 60 };
  const models = useMemo(() => (data?.models || []).filter((m) => m.svg), [data]);
  const materials = useMemo(() => data?.materials || [], [data]);
  const svgById = useMemo(() => Object.fromEntries(models.map((m) => [m.id, m.svg])), [models]);

  // Per-model family (grades + retail prices) so a fabric pick reprices exactly
  // like the internal configurator (productForGrade), keyed by family root.
  const families = useMemo(() => {
    const map = new Map();
    for (const m of models) {
      const fam = familyFromJson(m.family);
      if (fam) map.set(fam.root, fam);
    }
    return map;
  }, [models]);

  const resolvedById = useMemo(() => {
    const o = {};
    for (const m of models) {
      o[m.id] = {
        id: m.id, label: m.name, widthCm: m.widthCm, depthCm: m.depthCm,
        unitPrice: m.priceUsd, root: m.family?.root || m.root || null,
        offeredKeys: m.offeredFabricKeys || [],
      };
    }
    return o;
  }, [models]);

  const vm = useMemo(() => resolveConfigurator(placed, resolvedById, { scale: SCALE }), [placed, resolvedById]);
  const scene3d = useMemo(() => resolveTogoScene(scenePlacementsFromPlaced(placed, resolvedById)), [placed, resolvedById]);
  const selected = placed.find((p) => p.uid === selectedUid) || null;
  const selectedFamily = selected ? (families.get(resolvedById[selected.pieceId]?.root) || null) : null;
  const selResolved = selected ? resolvePlacement(selected, resolvedById) : null;
  const codeByUid = useMemo(() => {
    const o = {};
    for (const p of placed) if (p.material?.code) o[p.uid] = p.material.code;
    return o;
  }, [placed]);

  const addPiece = useCallback((modelId) => {
    const r = resolvedById[modelId]; if (!r) return;
    const fp = footprintOf(r, 0);
    const baseN = 40 + (placed.length % 6) * 26;
    const start = clampToPlan(baseN, baseN, fp.w, fp.h);
    const others = placed.map((p) => { const f = footprintOf(resolvedById[p.pieceId], p.rot); return { x: p.x, y: p.y, w: f.w, h: f.h }; });
    const snapped = snapPlacement({ x: start.x, y: start.y, w: fp.w, h: fp.h }, others);
    const c = clampToPlan(snapped.x, snapped.y, fp.w, fp.h);
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setPlaced((prev) => [...prev, { uid, pieceId: modelId, x: c.x, y: c.y, rot: 0 }]);
    setSelectedUid(uid);
  }, [resolvedById, placed]);

  const rotateSel = useCallback(() => {
    setPlaced((prev) => prev.map((p) => {
      if (p.uid !== selectedUid) return p;
      const rot = (p.rot + 90) % 360; const fp = footprintOf(resolvedById[p.pieceId], rot);
      return { ...p, rot, ...clampToPlan(p.x, p.y, fp.w, fp.h) };
    }));
  }, [selectedUid, resolvedById]);
  const deleteSel = useCallback(() => { setPlaced((prev) => prev.filter((p) => p.uid !== selectedUid)); setSelectedUid(null); }, [selectedUid]);

  // Material pick for the selected piece → reprice by grade + stamp swatch/subtype.
  const onPickMaterial = useCallback((pick) => {
    if (!selected) return;
    const p = selectedFamily ? productForGrade(selectedFamily, pick.grade) : null;
    setPlaced((prev) => prev.map((row) => (row.uid === selected.uid ? {
      ...row,
      material: {
        grade: pick.grade, fabric: pick.fabric, code: pick.code || '', swatchImageId: null,
        subtype: composeSubtype(pick.grade, pick.fabric),
        reference: p?.reference || '',
        unitPrice: p && p.priceUsd != null ? Number(p.priceUsd) : (resolvedById[row.pieceId]?.unitPrice ?? null),
      },
    } : row)));
  }, [selected, selectedFamily, resolvedById]);

  // Apply ONE fabric to EVERY piece, repricing each by its OWN bound model.
  const applyFabricToAll = useCallback((pick) => {
    setPlaced((prev) => prev.map((row) => {
      const fam = families.get(resolvedById[row.pieceId]?.root);
      const p = fam ? productForGrade(fam, pick.grade) : null;
      return {
        ...row,
        material: {
          grade: pick.grade, fabric: pick.fabric, code: pick.code || '', swatchImageId: null,
          subtype: composeSubtype(pick.grade, pick.fabric),
          reference: p?.reference || '',
          unitPrice: p && p.priceUsd != null ? Number(p.priceUsd) : (resolvedById[row.pieceId]?.unitPrice ?? null),
        },
      };
    }));
  }, [families, resolvedById]);

  const clearFabric = useCallback(() => {
    if (!selectedUid) return;
    setPlaced((prev) => prev.map((row) => (row.uid === selectedUid ? { ...row, material: undefined } : row)));
  }, [selectedUid]);

  // Download the plan as CAD (DXF) — opens in AutoCAD and every plan tool. A
  // genuine differentiator: consumer sofa configurators stop at PDF/image, so a
  // designer-grade, real-cm layout handed straight to the customer's architect.
  const downloadDxf = useCallback(() => {
    if (!placed.length) return;
    const placements = placementsFromPlaced(placed, resolvedById, svgById);
    const { dxf, filename } = resolveTogoDxf(placements, { name: data?.storeName || 'Togo' });
    downloadText(filename, dxf);
  }, [placed, resolvedById, svgById, data?.storeName]);

  const openMaterial = useCallback((mode) => {
    if (mode === 'one' && !selectedUid) return;
    if (mode === 'all' && !placed.length) return;
    setMatMode(mode);
    setMatOpen(true);
  }, [selectedUid, placed.length]);

  const dragRef = useRef(null);
  const onTileDown = useCallback((e, p) => {
    e.stopPropagation(); setSelectedUid(p.uid);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { uid: p.uid, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
  }, []);
  const onTileMove = useCallback((e) => {
    const d = dragRef.current; if (!d) return;
    const r = resolvedById[placed.find((p) => p.uid === d.uid)?.pieceId]; if (!r) return;
    setPlaced((prev) => {
      const me = prev.find((p) => p.uid === d.uid); if (!me) return prev;
      const fp = footprintOf(r, me.rot);
      const nx = d.ox + (e.clientX - d.sx) / SCALE, ny = d.oy + (e.clientY - d.sy) / SCALE;
      const others = prev.filter((p) => p.uid !== d.uid).map((p) => { const f = footprintOf(resolvedById[p.pieceId], p.rot); return { x: p.x, y: p.y, w: f.w, h: f.h }; });
      const snapped = snapPlacement({ x: nx, y: ny, w: fp.w, h: fp.h }, others);
      const c = clampToPlan(snapped.x, snapped.y, fp.w, fp.h);
      return prev.map((p) => (p.uid === d.uid ? { ...p, x: c.x, y: c.y } : p));
    });
  }, [placed, resolvedById]);
  const onTileUp = useCallback((e) => { dragRef.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); }, []);

  if (cat.status === 'loading') {
    return <Centered><Loader2 size={20} className="animate-spin text-ink-400" /></Centered>;
  }
  if (cat.status === 'error' || !data?.configured) {
    return (
      <Centered>
        <div className="text-center text-ink-500 text-sm flex flex-col items-center gap-2">
          <Sofa size={24} className="text-ink-300" />
          {cat.status === 'error' ? 'No se pudo cargar el configurador.' : 'El configurador aún no está disponible.'}
        </div>
      </Centered>
    );
  }

  if (step === 'done') return <DoneScreen storeName={data.storeName} onReset={() => { setPlaced([]); setSelectedUid(null); setStep('build'); }} />;
  if (step === 'form') {
    return (
      <RequestForm
        storeName={data.storeName}
        items={placed.map((p) => ({
          modelId: p.pieceId, x: p.x, y: p.y, rot: p.rot,
          ...(p.material ? { material: { grade: p.material.grade, fabric: p.material.fabric, code: p.material.code } } : {}),
        }))}
        estimateUsd={vm.subtotalUsd}
        totalDop={formatMoney(vm.subtotalUsd, 'DOP', rates)}
        onBack={() => setStep('build')}
        onDone={() => setStep('done')}
      />
    );
  }

  return (
    <div className="min-h-full bg-surface text-ink-900 p-3 sm:p-4">
      <header className="flex items-center gap-2.5 mb-3">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-brand-50 text-brand-600"><Sofa size={16} /></span>
        <div className="min-w-0">
          <h1 className="font-display font-semibold text-base leading-tight truncate">Configura tu Togo</h1>
          <p className="text-[11px] text-ink-500">Arrastra las piezas, elige tus telas y arma tu sofá · {data.storeName}</p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)] gap-3 items-start">
        <aside className="rounded-xl border border-ink-200 bg-surface p-2.5 space-y-2">
          <h2 className="text-xs font-display font-semibold text-ink-700">Piezas</h2>
          <ul className="grid grid-cols-2 lg:grid-cols-1 gap-2">
            {models.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => addPiece(m.id)} className="w-full flex items-center gap-2.5 text-left rounded-lg border border-ink-100 hover:bg-ink-50 p-2 transition-colors">
                  <span className="shrink-0 w-12 h-12 rounded-md bg-ink-50 text-ink-700 p-1 grid place-items-center" dangerouslySetInnerHTML={{ __html: m.svg }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium truncate">{m.name}</span>
                    <span className="block text-[11px] text-ink-500 tabular-nums">{m.widthCm}×{m.depthCm} cm</span>
                    {m.priceUsd != null && <span className="block text-[11px] font-medium text-brand-700 tabular-nums">{formatMoney(m.priceUsd, 'DOP', rates)}</span>}
                  </span>
                  <Plus size={15} className="shrink-0 text-ink-400" />
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="space-y-3 min-w-0">
          <div className="rounded-xl border border-ink-200 bg-surface p-2.5">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                {/* 2D plan (edit) ⇄ 3D preview (covered in the chosen fabric). */}
                <div className="inline-flex rounded-lg border border-ink-200 overflow-hidden shrink-0">
                  <button type="button" onClick={() => setView('2d')} aria-pressed={view === '2d'} className={`px-2.5 py-1 text-xs inline-flex items-center gap-1 ${view === '2d' ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600 hover:bg-ink-50'}`}><Square size={13} /> 2D</button>
                  <button type="button" onClick={() => setView('3d')} aria-pressed={view === '3d'} className={`px-2.5 py-1 text-xs inline-flex items-center gap-1 border-l border-ink-200 ${view === '3d' ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600 hover:bg-ink-50'}`}><Box size={13} /> 3D</button>
                </div>
                <span className="text-[11px] text-ink-500 hidden sm:inline truncate">{view === '3d' ? 'Arrastra para girar · rueda para acercar' : (vm.count ? 'Clic para seleccionar · arrastra para mover' : 'Toca una pieza para agregarla')}</span>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => openMaterial('all')} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Aplicar una misma tela a todas las piezas"><Layers size={14} /> Tela a todas</button>
                <button type="button" onClick={downloadDxf} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Descargar el plano en CAD (DXF) — se abre en AutoCAD y cualquier programa de planos"><FileDown size={14} /> Plano</button>
                <button type="button" onClick={() => { setPlaced([]); setSelectedUid(null); }} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Vaciar"><Eraser size={14} /></button>
              </div>
            </div>

            {/* Selected-piece panel — name, fabric, price, size + per-piece actions. */}
            {selected && selResolved && (
              <div className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/50 px-3 py-2">
                <span className="shrink-0 w-9 h-9 rounded-md bg-surface text-ink-700 p-0.5 grid place-items-center" dangerouslySetInnerHTML={{ __html: svgById[selected.pieceId] }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{selResolved.label}</div>
                  <div className="text-[11px] text-ink-500 flex items-center gap-1.5 flex-wrap">
                    {selected.material?.code && <ImageView id={null} fallbackUrl={swatchUrl(selected.material.code)} alt="" className="w-3 h-3 rounded-sm object-cover" />}
                    <span>{selected.material?.fabric || (selectedFamily ? 'Sin tela' : 'Sin opciones de tela')}</span>
                    <span className="text-ink-300">·</span>
                    <span className="tabular-nums font-medium text-ink-700">{selResolved.unitPrice != null ? formatMoney(selResolved.unitPrice, 'DOP', rates) : 'sin precio'}</span>
                    <span className="text-ink-400 tabular-nums">· {selResolved.widthCm}×{selResolved.depthCm} cm</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {selectedFamily && (
                    <button type="button" onClick={() => openMaterial('one')} className="btn-ghost text-xs" title="Elegir tela"><Palette size={14} /> Tela</button>
                  )}
                  {selected.material && (
                    <button type="button" onClick={clearFabric} className="btn-ghost text-xs text-ink-500" title="Quitar tela"><X size={14} /></button>
                  )}
                  <button type="button" onClick={rotateSel} className="btn-ghost text-xs" title="Rotar"><RotateCw size={14} /></button>
                  <button type="button" onClick={deleteSel} className="btn-ghost text-xs text-red-600" title="Quitar"><Trash2 size={14} /></button>
                </div>
              </div>
            )}

            {view === '3d' ? (
              <TogoScene3D scene3d={scene3d} className="w-full h-[58vh] min-h-[420px] rounded-lg border border-ink-200 overflow-hidden bg-ink-50/40" />
            ) : (
            <div className="overflow-auto rounded-lg border border-ink-200 bg-ink-50/40">
              <div
                className="relative mx-auto"
                style={{
                  width: vm.canvas.wPx, height: vm.canvas.hPx,
                  backgroundSize: `${50 * SCALE}px ${50 * SCALE}px`,
                  backgroundImage:
                    'linear-gradient(to right, rgba(0,0,0,0.05) 1px, transparent 1px),'
                    + 'linear-gradient(to bottom, rgba(0,0,0,0.05) 1px, transparent 1px)',
                }}
                onPointerDown={() => setSelectedUid(null)}
              >
                {vm.tiles.map((t) => {
                  const sel = t.uid === selectedUid;
                  const code = codeByUid[t.uid];
                  return (
                    <div
                      key={t.uid}
                      onPointerDown={(e) => onTileDown(e, placed.find((p) => p.uid === t.uid))}
                      onPointerMove={onTileMove}
                      onPointerUp={onTileUp}
                      className={['absolute touch-none cursor-grab active:cursor-grabbing select-none', sel ? 'z-20' : 'z-10'].join(' ')}
                      style={{ left: t.leftPx, top: t.topPx, width: t.wPx, height: t.hPx }}
                    >
                      <div className={['absolute inset-0 rounded-md', sel ? 'ring-2 ring-brand-500 bg-brand-500/5' : 'ring-1 ring-transparent hover:ring-ink-300'].join(' ')} />
                      <div className="absolute top-1/2 left-1/2 text-ink-800" style={{ width: t.innerWPx, height: t.innerHPx, transform: `translate(-50%, -50%) rotate(${t.rot}deg)` }} dangerouslySetInnerHTML={{ __html: svgById[t.pieceId] }} />
                      <span className="absolute left-1/2 -translate-x-1/2 bottom-0.5 inline-flex items-center gap-1 rounded bg-ink-900/70 text-white text-[9px] leading-none px-1 py-0.5 tabular-nums pointer-events-none">
                        {code && <img src={swatchUrl(code)} alt="" className="w-2.5 h-2.5 rounded-sm object-cover" />}
                        {t.dimsLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            )}
          </div>

          <div className="rounded-xl border border-ink-200 bg-surface p-3 flex flex-wrap items-center justify-between gap-3 sticky bottom-2">
            <div>
              <div className="text-[10px] text-ink-500 uppercase tracking-wide">Estimado ({vm.count} pieza{vm.count === 1 ? '' : 's'})</div>
              <div className="text-lg font-display font-semibold tabular-nums">{formatMoney(vm.subtotalUsd, 'DOP', rates)}</div>
              {vm.count > 0 && vm.overallCm.widthCm > 0 && (
                <div className="text-[11px] text-ink-500 tabular-nums">Conjunto: {vm.overallCm.widthCm} × {vm.overallCm.depthCm} cm</div>
              )}
            </div>
            <button type="button" onClick={() => setStep('form')} disabled={!vm.count} className="btn-primary text-sm disabled:opacity-50">
              Solicitar cotización <ArrowRight size={15} />
            </button>
          </div>
        </section>
      </div>

      <FabricModal
        open={matOpen}
        onClose={() => setMatOpen(false)}
        onSelect={matMode === 'all' ? applyFabricToAll : onPickMaterial}
        materials={materials}
        family={matMode === 'all' ? null : selectedFamily}
        nameFilter={matMode === 'all' ? undefined : nameFilterOf(resolvedById[selected?.pieceId]?.offeredKeys)}
        currentGrade={matMode === 'all' ? undefined : selected?.material?.grade}
        currentFabric={matMode === 'all' ? undefined : selected?.material?.fabric}
      />
    </div>
  );
}

function nameFilterOf(keys) {
  return Array.isArray(keys) && keys.length ? new Set(keys) : undefined;
}

/** The fabric picker — the SAME MaterialColorPicker the internal editor uses,
 *  wrapped in a Modal, fed public-safe catalog data (no DB). */
function FabricModal({ open, onClose, onSelect, materials, family, nameFilter, currentGrade, currentFabric }) {
  const [title, setTitle] = useState('Elegir material');
  useEffect(() => { if (open) setTitle('Elegir material'); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      {open && (
        <MaterialColorPicker
          materials={materials}
          family={family}
          nameFilter={nameFilter}
          currentGrade={currentGrade}
          currentFabric={currentFabric}
          autoDrill
          onPick={(material, color) => { onSelect(toPick(material, color)); onClose(); }}
          onTitleChange={setTitle}
        />
      )}
    </Modal>
  );
}

function Centered({ children }) {
  return <div className="min-h-full bg-surface grid place-items-center p-6">{children}</div>;
}

function RequestForm({ storeName, items, estimateUsd, totalDop, onBack, onDone }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const valid = form.name.trim() && (form.phone.trim() || form.email.trim());

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      await submitTogoRequest({ contact: { name: form.name, phone: form.phone, email: form.email }, items, estimateUsd, note: form.note });
      onDone();
    } catch (err) {
      setError(err?.message || 'No se pudo enviar. Intenta de nuevo.');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-surface text-ink-900 p-4 grid place-items-center">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-ink-200 bg-surface p-5 space-y-3.5">
        <button type="button" onClick={onBack} className="btn-ghost text-xs text-ink-500"><ArrowLeft size={14} /> Volver al diseño</button>
        <div>
          <h2 className="font-display font-semibold text-lg">Solicita tu cotización</h2>
          <p className="text-xs text-ink-500 mt-0.5">{storeName} te contactará con el precio final y la disponibilidad. Estimado: <b className="text-ink-700 tabular-nums">{totalDop}</b></p>
        </div>
        <div>
          <label className="label">Nombre *</label>
          <input className="input" value={form.name} onChange={set('name')} placeholder="Tu nombre" autoFocus />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">WhatsApp / Teléfono</label>
            <input className="input" value={form.phone} onChange={set('phone')} placeholder="809…" inputMode="tel" />
          </div>
          <div>
            <label className="label">Correo</label>
            <input className="input" value={form.email} onChange={set('email')} placeholder="tu@correo.com" inputMode="email" />
          </div>
        </div>
        <div>
          <label className="label">Nota (opcional)</label>
          <textarea className="input min-h-[72px]" value={form.note} onChange={set('note')} placeholder="Dudas, dirección de entrega…" />
        </div>
        {error && <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800 flex items-start gap-2"><AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {error}</div>}
        <p className="text-[11px] text-ink-400">* Indica al menos un teléfono o correo para que podamos contactarte.</p>
        <button type="submit" disabled={!valid || busy} className="btn-primary w-full justify-center disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Enviar solicitud
        </button>
      </form>
    </div>
  );
}

function DoneScreen({ storeName, onReset }) {
  return (
    <div className="min-h-full bg-surface text-ink-900 p-6 grid place-items-center">
      <div className="text-center max-w-sm space-y-3">
        <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 inline-flex items-center justify-center"><Check size={26} /></div>
        <h2 className="font-display font-semibold text-lg">¡Solicitud enviada!</h2>
        <p className="text-sm text-ink-500">{storeName} recibió tu diseño y te contactará pronto con el precio final y la disponibilidad.</p>
        <button type="button" onClick={onReset} className="btn-ghost text-sm">Diseñar otro</button>
      </div>
    </div>
  );
}
