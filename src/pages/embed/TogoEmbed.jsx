import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Sofa, RotateCw, Trash2, Plus, Loader2, Eraser, ArrowRight, ArrowLeft, Check, AlertCircle, Palette, Layers, X, FileDown, Box, Square, View, MoreHorizontal, Receipt, Magnet } from 'lucide-react';
import { formatMoney } from '../../lib/format.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import { productForGrade } from '../../lib/catalog.js';
import { composeSubtype, composeFabricLabel } from '../../lib/subtype.js';
import { downloadText } from '../../lib/csv.js';
import { fetchTogoCatalog, submitTogoRequest } from '../../lib/togoEmbed.js';
import {
  resolveConfigurator, resolvePlacement, snapPlacement, footprintOf, clampToPlan, PX_PER_CM,
  resolveTogoDxf, placementsFromPlaced, resolveTogoScene, scenePlacementsFromPlaced, compactPlaced,
} from '../../core/quote/index.js';
import Modal from '../../components/Modal.jsx';
import MaterialColorPicker from '../../components/quote-builder/MaterialColorPicker.jsx';
import ImageView from '../../components/ImageView.jsx';
import TogoScene3D from '../../components/togo/TogoScene3D.jsx';
import TogoArViewer from '../../components/togo/TogoArViewer.jsx';

const SCALE = PX_PER_CM;

// Force a stored plan SVG to FILL its footprint tile. The stored SVGs carry only a
// (square) viewBox — no width/height — so the browser renders them square and
// top-anchored, leaving a strip at the bottom of a non-square tile that swings to
// the side when the piece is rotated. width/height 100% makes the element fill the
// tile; preserveAspectRatio="none" stretches the drawing to fill it (no letterbox).
const fillSvg = (svg) =>
  (typeof svg === 'string' && svg.startsWith('<svg') && !svg.includes('preserveAspectRatio'))
    ? svg.replace('<svg', '<svg preserveAspectRatio="none" width="100%" height="100%"')
    : svg;

// The material editor's finish presets — physically-based fabric looks that
// re-skin the 3D visualizer live (roughness + the sheen lobe that makes fabric
// read as fabric). Fabric/colour stay per-piece (the swatch picker); the finish
// is the configuration-wide surface character.
const FINISHES = [
  { key: 'mate', label: 'Mate', roughness: 0.95, sheen: 0.12, sheenRoughness: 0.85 },
  { key: 'lino', label: 'Lino', roughness: 0.82, sheen: 0.5, sheenRoughness: 0.55 },
  { key: 'terciopelo', label: 'Terciopelo', roughness: 0.6, sheen: 1.0, sheenRoughness: 0.3 },
  { key: 'cuero', label: 'Cuero', roughness: 0.4, sheen: 0.08, sheenRoughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.35 },
];

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
  const [arOpen, setArOpen] = useState(false);   // "Ver en tu espacio" (WebAR)
  const [matMode, setMatMode] = useState('one'); // 'one' (selected piece) | 'all'
  const [view, setView] = useState('2d');        // '2d' plan editor | '3d' preview
  const [finishKey, setFinishKey] = useState('lino'); // material editor: surface finish
  const [weave, setWeave] = useState(3);              // material editor: weave/quilt scale
  const [sheet, setSheet] = useState(null);      // mobile bottom sheet: 'pieces' | 'material' | null
  const [moreOpen, setMoreOpen] = useState(false); // mobile toolbar "⋯ Opciones" popover
  const [hoveredPieceId, setHoveredPieceId] = useState(null); // hover-link plan ⇄ palette
  const [quoteOpen, setQuoteOpen] = useState(false); // the quote summary sheet
  const material = useMemo(() => {
    const f = FINISHES.find((x) => x.key === finishKey) || FINISHES[1];
    return {
      roughness: f.roughness, sheen: f.sheen, sheenRoughness: f.sheenRoughness,
      clearcoat: f.clearcoat ?? 0, clearcoatRoughness: f.clearcoatRoughness ?? 0.4,
      repeat: weave, normalScale: 1.0,
    };
  }, [finishKey, weave]);

  useEffect(() => {
    let active = true;
    fetchTogoCatalog()
      .then((d) => { if (active) setCat({ status: 'ready', data: d, error: null }); })
      .catch((e) => { if (active) setCat({ status: 'error', data: null, error: e?.message || 'Error' }); });
    return () => { active = false; };
  }, []);

  // The material editor only makes sense in 3D (the finish/weave re-skin the
  // visualizer). Drop back to 2D → close its bottom sheet so it can't dangle.
  useEffect(() => { if (view !== '3d') setSheet((s) => (s === 'material' ? null : s)); }, [view]);

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

  // The TRUE footprint of each uploaded mesh (url → {widthCm, depthCm}), measured
  // by the 3D once it loads. A dealer's FBX can disagree with the catalogue dims
  // (e.g. a "102×102" corner whose mesh is actually deeper); using the real
  // footprint keeps the plan, the placement and the 3D in agreement — and lets a
  // non-square piece ROTATE correctly instead of leaving dead space in a wrong
  // square tile.
  const [meshDims, setMeshDims] = useState({});
  const onMeshFootprint = useCallback((url, dims) => {
    if (!url || !(dims?.widthCm > 0) || !(dims?.depthCm > 0)) return;
    setMeshDims((prev) => {
      const cur = prev[url];
      if (cur && Math.abs(cur.widthCm - dims.widthCm) < 0.5 && Math.abs(cur.depthCm - dims.depthCm) < 0.5) return prev;
      return { ...prev, [url]: dims };
    });
  }, []);

  const resolvedById = useMemo(() => {
    const o = {};
    for (const m of models) {
      const real = m.mesh?.url ? meshDims[m.mesh.url] : null;   // measured mesh footprint wins
      o[m.id] = {
        id: m.id, label: m.name,
        widthCm: real?.widthCm ?? m.widthCm,
        depthCm: real?.depthCm ?? m.depthCm,
        unitPrice: m.priceUsd, root: m.family?.root || m.root || null,
        offeredKeys: m.offeredFabricKeys || [],
        mesh: m.mesh || null,
      };
    }
    return o;
  }, [models, meshDims]);

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

  // Togo's price depends on the fabric GRADE, so a piece has no real price until
  // a fabric is chosen: the estimate sums ONLY fabric-chosen pieces (the rest
  // read "Elige una tela"), and the palette shows no price at all. USD throughout.
  const pricedUsd = useMemo(
    () => placed.reduce((s, p) => s + (p.material ? (Number(p.material.unitPrice) || 0) : 0), 0),
    [placed],
  );
  const pendingFabric = useMemo(() => placed.filter((p) => !p.material).length, [placed]);

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

  // uid-parameterized so the on-plan hover controls can rotate/delete ANY piece
  // (not just the selected one) without a round-trip to the toolbar.
  const rotatePiece = useCallback((uid) => {
    setPlaced((prev) => prev.map((p) => {
      if (p.uid !== uid) return p;
      const rot = (p.rot + 90) % 360; const fp = footprintOf(resolvedById[p.pieceId], rot);
      return { ...p, rot, ...clampToPlan(p.x, p.y, fp.w, fp.h) };
    }));
  }, [resolvedById]);
  const deletePiece = useCallback((uid) => {
    setPlaced((prev) => prev.filter((p) => p.uid !== uid));
    setSelectedUid((s) => (s === uid ? null : s));
  }, []);
  const rotateSel = useCallback(() => rotatePiece(selectedUid), [rotatePiece, selectedUid]);
  const deleteSel = useCallback(() => deletePiece(selectedUid), [deletePiece, selectedUid]);

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

  // Pull every piece flush — closes any empty gap between pieces (e.g. left behind
  // when a middle piece is deleted) so the sectional reads as one connected sofa.
  const connectPieces = useCallback(() => {
    setPlaced((prev) => compactPlaced(prev, resolvedById));
  }, [resolvedById]);

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
        estimateUsd={pricedUsd}
        total={formatMoney(pricedUsd, 'USD', rates)}
        onBack={() => setStep('build')}
        onDone={() => setStep('done')}
      />
    );
  }

  // Shared building blocks — defined once, rendered in BOTH the desktop layout
  // and the mobile bottom sheets / docks so screen never drifts from sheet.
  const piecesList = (
    <PiecesList models={models} onAdd={(id) => { addPiece(id); setSheet(null); }}
      hoveredPieceId={hoveredPieceId} onHover={setHoveredPieceId} />
  );
  const materialEditor = (
    <MaterialEditor finishKey={finishKey} setFinishKey={setFinishKey} weave={weave} setWeave={setWeave} />
  );
  const canvas = (
    <CanvasArea
      view={view} vm={vm} scene3d={scene3d} material={material} svgById={svgById}
      selectedUid={selectedUid} setSelectedUid={setSelectedUid} codeByUid={codeByUid}
      placed={placed} onTileDown={onTileDown} onTileMove={onTileMove} onTileUp={onTileUp}
      hoveredPieceId={hoveredPieceId} setHoveredPieceId={setHoveredPieceId}
      onRotatePiece={rotatePiece} onDeletePiece={deletePiece} onMeshFootprint={onMeshFootprint}
    />
  );
  // 2D⇄3D segmented toggle — reused in both the desktop strip and the mobile bar.
  const viewToggle = (
    <div className="inline-flex rounded-lg border border-ink-200 overflow-hidden shrink-0 bg-surface">
      <button type="button" onClick={() => setView('2d')} aria-pressed={view === '2d'} className={`px-2.5 py-1 text-xs inline-flex items-center gap-1 ${view === '2d' ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600 hover:bg-ink-50'}`}><Square size={13} /> 2D</button>
      <button type="button" onClick={() => setView('3d')} aria-pressed={view === '3d'} className={`px-2.5 py-1 text-xs inline-flex items-center gap-1 border-l border-ink-200 ${view === '3d' ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600 hover:bg-ink-50'}`}><Box size={13} /> 3D</button>
    </div>
  );

  return (
    <div className="min-h-full bg-surface text-ink-900">
      <div className="mx-auto w-full max-w-[1400px] px-3 sm:px-4 lg:px-6 pt-3 sm:pt-4 pb-28 lg:pb-6">
        <header className="flex items-center gap-2.5 mb-3 sm:mb-4">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-brand-50 text-brand-600"><Sofa size={16} /></span>
          <div className="min-w-0">
            <h1 className="font-display font-semibold text-base sm:text-lg leading-tight truncate">Configura tu Togo</h1>
            <p className="text-[11px] sm:text-xs text-ink-500 truncate">Arrastra las piezas, elige tus telas y arma tu sofá · {data.storeName}</p>
          </div>
        </header>

        {/* ─── DESKTOP (lg+): centered, balanced 3-zone layout ─── pieces rail ·
            canvas hero · estimate dock. The whole thing is capped to the
            max-width container above, so it never sprawls edge-to-edge. */}
        <div className="hidden lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] gap-5 items-start">
          <aside className="card p-3 space-y-2.5 sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-auto">
            <h2 className="text-xs font-display font-semibold text-ink-700 uppercase tracking-[0.06em]">Piezas</h2>
            {piecesList}
          </aside>

          <section className="space-y-5 min-w-0">
            <div className="card p-3 sm:p-4 space-y-3">
              {/* Toolbar — view toggle + the configuration-wide actions. */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0">
                  {viewToggle}
                  <span className="text-xs text-ink-500 truncate">{view === '3d' ? 'Arrastra para girar · rueda para acercar' : (vm.count ? 'Clic para seleccionar · arrastra para mover' : 'Toca una pieza para agregarla')}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={connectPieces} disabled={vm.count < 2} className="btn-ghost text-xs disabled:opacity-40" title="Juntar todas las piezas — cierra los espacios vacíos entre módulos"><Magnet size={14} /> Conectar</button>
                  <button type="button" onClick={() => openMaterial('all')} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Aplicar una misma tela a todas las piezas"><Layers size={14} /> Tela a todas</button>
                  <button type="button" onClick={() => setArOpen(true)} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Ver tu sofá a tamaño real en tu sala (Realidad Aumentada)"><View size={14} /> En tu espacio</button>
                  <button type="button" onClick={downloadDxf} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Descargar el plano en CAD (DXF) — se abre en AutoCAD y cualquier programa de planos"><FileDown size={14} /> Plano</button>
                  <button type="button" onClick={() => setQuoteOpen(true)} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Ver el resumen de tu cotización"><Receipt size={14} /> Resumen</button>
                  <button type="button" onClick={() => { setPlaced([]); setSelectedUid(null); }} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Vaciar"><Eraser size={14} /></button>
                </div>
              </div>

              {/* Selected-piece strip — name, fabric, price, size + per-piece actions. */}
              {selected && selResolved && (
                <SelectedStrip
                  selected={selected} selResolved={selResolved} selectedFamily={selectedFamily}
                  svgById={svgById} rates={rates}
                  onPickFabric={() => openMaterial('one')} onClearFabric={clearFabric}
                  onRotate={rotateSel} onDelete={deleteSel}
                />
              )}

              {/* Material editor strip — only meaningful in 3D (re-skins the visualizer). */}
              {view === '3d' && materialEditor}

              {canvas}
            </div>
          </section>
        </div>

        {/* ─── MOBILE (< lg): canvas is the hero; controls live in dynamic
            menus (bottom sheets) + a sticky dock so nothing crowds the plan. ─── */}
        <div className="lg:hidden space-y-3">
          {/* Compact bar: view toggle + secondary actions folded behind ⋯. */}
          <div className="flex items-center justify-between gap-2">
            {viewToggle}
            <div className="relative">
              <button type="button" onClick={() => setMoreOpen((v) => !v)} disabled={!vm.count} aria-expanded={moreOpen} className="btn-ghost text-xs disabled:opacity-40" title="Más opciones">
                <MoreHorizontal size={16} /> Opciones
              </button>
              {moreOpen && vm.count > 0 && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} aria-hidden />
                  <div className="absolute right-0 top-full mt-1 z-40 w-52 rounded-xl border border-ink-200 bg-surface shadow-pop p-1.5 flex flex-col gap-0.5 animate-in fade-in slide-in-from-top-1 duration-150">
                    <button type="button" onClick={() => { setMoreOpen(false); openMaterial('all'); }} className="btn-ghost justify-start text-sm"><Layers size={15} /> Tela a todas</button>
                    <button type="button" onClick={() => { setMoreOpen(false); connectPieces(); }} className="btn-ghost justify-start text-sm"><Magnet size={15} /> Conectar piezas</button>
                    <button type="button" onClick={() => { setMoreOpen(false); setArOpen(true); }} className="btn-ghost justify-start text-sm"><View size={15} /> Ver en tu espacio</button>
                    <button type="button" onClick={() => { setMoreOpen(false); downloadDxf(); }} className="btn-ghost justify-start text-sm"><FileDown size={15} /> Plano (DXF)</button>
                    <button type="button" onClick={() => { setMoreOpen(false); setQuoteOpen(true); }} className="btn-ghost justify-start text-sm"><Receipt size={15} /> Resumen</button>
                    <button type="button" onClick={() => { setMoreOpen(false); setPlaced([]); setSelectedUid(null); }} className="btn-ghost justify-start text-sm text-red-600"><Eraser size={15} /> Vaciar</button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* The canvas — the hero. Sized large via CanvasArea's mobile heights. */}
          {canvas}

          {/* Add-piece + Material entries → open the bottom sheets. Material only
              in 3D (the finish/weave editor has no effect on the 2D plan). */}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSheet('pieces')} className="btn-primary flex-1 justify-center text-sm">
              <Plus size={16} /> Agregar pieza
            </button>
            {view === '3d' && (
              <button type="button" onClick={() => setSheet('material')} className="btn-secondary text-sm shrink-0">
                <Palette size={15} /> Material
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ─── Mobile sticky bottom dock — estimate + the single primary CTA;
          a contextual selected-piece bar floats just ABOVE it when a piece is
          picked. Both are mobile-only (lg:hidden); desktop uses its own dock. ─── */}
      <div className="lg:hidden">
        {selected && selResolved && (
          <div className="fixed inset-x-0 bottom-[4.75rem] z-40 px-3 pb-2 pointer-events-none">
            <div className="pointer-events-auto mx-auto max-w-[1400px]">
              <SelectedStrip
                selected={selected} selResolved={selResolved} selectedFamily={selectedFamily}
                svgById={svgById} rates={rates} compact
                onPickFabric={() => openMaterial('one')} onClearFabric={clearFabric}
                onRotate={rotateSel} onDelete={deleteSel}
              />
            </div>
          </div>
        )}
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-surface/95 backdrop-blur px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-[1400px] flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] text-ink-500 uppercase tracking-wide">Estimado ({vm.count} pieza{vm.count === 1 ? '' : 's'})</div>
              {pricedUsd > 0
                ? <div className="text-lg font-display font-semibold tabular-nums leading-tight">{formatMoney(pricedUsd, 'USD', rates)}{pendingFabric > 0 && <span className="text-[11px] font-normal text-ink-400"> · {pendingFabric} sin tela</span>}</div>
                : <div className="text-sm text-ink-500 leading-tight py-0.5">{vm.count ? 'Elige una tela' : '—'}</div>}
              {vm.count > 0 && vm.overallCm.widthCm > 0 && (
                <div className="text-[11px] text-ink-500 tabular-nums">Conjunto: {vm.overallCm.widthCm} × {vm.overallCm.depthCm} cm</div>
              )}
            </div>
            <button type="button" onClick={() => setStep('form')} disabled={!vm.count} className="btn-primary text-sm disabled:opacity-50 shrink-0">
              Cotizar <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* ─── Desktop estimate / CTA dock — full container width, at the bottom
          of the centered container. Sticky so it stays in reach as the canvas
          grows. ─── */}
      <div className="hidden lg:block">
        <div className="mx-auto w-full max-w-[1400px] px-6 pb-6">
          <div className="card p-4 flex flex-wrap items-center justify-between gap-3 sticky bottom-4">
            <div>
              <div className="text-[10px] text-ink-500 uppercase tracking-wide">Estimado ({vm.count} pieza{vm.count === 1 ? '' : 's'})</div>
              {pricedUsd > 0
                ? <div className="text-xl font-display font-semibold tabular-nums">{formatMoney(pricedUsd, 'USD', rates)}{pendingFabric > 0 && <span className="text-xs font-normal text-ink-400"> · {pendingFabric} sin tela</span>}</div>
                : <div className="text-base text-ink-500">{vm.count ? 'Elige una tela para ver el estimado' : '—'}</div>}
              {vm.count > 0 && vm.overallCm.widthCm > 0 && (
                <div className="text-[11px] text-ink-500 tabular-nums">Conjunto: {vm.overallCm.widthCm} × {vm.overallCm.depthCm} cm</div>
              )}
            </div>
            <button type="button" onClick={() => setStep('form')} disabled={!vm.count} className="btn-primary text-sm disabled:opacity-50">
              Solicitar cotización <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* ─── Mobile bottom sheets — Piezas (add) and Material (3D finish). ─── */}
      <BottomSheet open={sheet === 'pieces'} onClose={() => setSheet(null)} title="Agregar pieza">
        {piecesList}
      </BottomSheet>
      <BottomSheet open={sheet === 'material'} onClose={() => setSheet(null)} title="Material">
        <p className="text-xs text-ink-500 mb-3">El acabado re-viste todas las piezas en el visualizador 3D. La tela y el color se eligen por pieza.</p>
        {materialEditor}
      </BottomSheet>

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

      <TogoArViewer open={arOpen} onClose={() => setArOpen(false)} scene3d={scene3d} material={material} storeName={data.storeName} />

      <QuoteSheet
        open={quoteOpen} onClose={() => setQuoteOpen(false)}
        placed={placed} resolvedById={resolvedById} svgById={svgById} rates={rates}
        subtotalUsd={pricedUsd} pending={pendingFabric} overallCm={vm.overallCm}
        onRequest={() => { setQuoteOpen(false); setStep('form'); }}
      />
    </div>
  );
}

/** Vertical list of Togo models (thumbnail · name · dims · price + add button).
 *  ONE list shared by the desktop pieces rail and the mobile "Agregar pieza"
 *  sheet, so they can never present a different catalog. */
function PiecesList({ models, onAdd, hoveredPieceId, onHover }) {
  return (
    <ul className="space-y-2">
      {models.map((m) => {
        // Highlighted when its placed instance is hovered on the plan (and the
        // reverse: hovering this row highlights its pieces on the plan).
        const hot = hoveredPieceId != null && m.id === hoveredPieceId;
        return (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onAdd(m.id)}
              onMouseEnter={() => onHover?.(m.id)}
              onMouseLeave={() => onHover?.(null)}
              className={`w-full flex items-center gap-3 text-left rounded-xl border p-2.5 transition-colors ${hot ? 'border-brand-400 bg-brand-50/70 ring-1 ring-brand-300' : 'border-ink-100 hover:bg-ink-50 active:bg-ink-100'}`}
            >
              <span className="shrink-0 w-14 h-14 rounded-lg bg-ink-50 text-ink-700 p-1.5 grid place-items-center" dangerouslySetInnerHTML={{ __html: m.svg }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium truncate">{m.name}</span>
                <span className="block text-[11px] text-ink-500 tabular-nums">{m.widthCm}×{m.depthCm} cm</span>
              </span>
              <span className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-brand-50 text-brand-600"><Plus size={16} /></span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Material editor — surface finish chips (Mate/Lino/Terciopelo/Cuero) + the
 *  weave/quilt ("Trama") slider. The finish re-skins every piece in the 3D
 *  visualizer live; fabric/colour stay per-piece via the swatch picker. Shared
 *  by the desktop strip and the mobile Material sheet. */
function MaterialEditor({ finishKey, setFinishKey, weave, setWeave }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-ink-200 bg-surface px-3 py-2.5">
      <span className="text-[11px] font-medium text-ink-600 inline-flex items-center gap-1"><Palette size={13} /> Material</span>
      <div className="inline-flex rounded-md border border-ink-200 overflow-hidden">
        {FINISHES.map((f, i) => (
          <button key={f.key} type="button" onClick={() => setFinishKey(f.key)} aria-pressed={finishKey === f.key}
            className={`px-2.5 py-1 text-[11px] ${i ? 'border-l border-ink-200' : ''} ${finishKey === f.key ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600 hover:bg-ink-50'}`}>{f.label}</button>
        ))}
      </div>
      <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-500 ml-1">
        Trama
        <input type="range" min="1.5" max="5" step="0.5" value={weave} onChange={(e) => setWeave(Number(e.target.value))} className="w-24 accent-brand-500" />
      </label>
    </div>
  );
}

/** Selected-piece strip — thumbnail, label, fabric swatch, price, dims + the
 *  per-piece actions (Tela / clear-fabric / rotate / delete). `compact` packs
 *  it onto one floating row for the mobile contextual bar. */
function SelectedStrip({ selected, selResolved, selectedFamily, svgById, rates, onPickFabric, onClearFabric, onRotate, onDelete, compact = false }) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border border-brand-200 ${compact ? 'bg-surface shadow-pop' : 'bg-brand-50/50'} px-3 py-2`}>
      <span className="shrink-0 w-9 h-9 rounded-md bg-surface text-ink-700 p-0.5 grid place-items-center" dangerouslySetInnerHTML={{ __html: svgById[selected.pieceId] }} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{selResolved.label}</div>
        <div className="text-[11px] text-ink-500 flex items-center gap-1.5 flex-wrap">
          {selected.material?.code && <ImageView id={null} fallbackUrl={swatchUrl(selected.material.code)} alt="" className="w-3 h-3 rounded-sm object-cover" />}
          <span className="truncate">{selected.material?.fabric || (selectedFamily ? 'Sin tela' : 'Sin opciones de tela')}</span>
          {selected.material && selResolved.unitPrice != null && (
            <>
              <span className="text-ink-300">·</span>
              <span className="tabular-nums font-medium text-ink-700">{formatMoney(selResolved.unitPrice, 'USD', rates)}</span>
            </>
          )}
          <span className="text-ink-400 tabular-nums hidden sm:inline">· {selResolved.widthCm}×{selResolved.depthCm} cm</span>
        </div>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {selectedFamily && (
          <button type="button" onClick={onPickFabric} className="btn-ghost text-xs" title="Elegir tela"><Palette size={14} /><span className="hidden sm:inline"> Tela</span></button>
        )}
        {selected.material && (
          <button type="button" onClick={onClearFabric} className="btn-icon text-ink-500" title="Quitar tela"><X size={15} /></button>
        )}
        <button type="button" onClick={onRotate} className="btn-icon" title="Rotar"><RotateCw size={15} /></button>
        <button type="button" onClick={onDelete} className="btn-icon text-red-600" title="Quitar"><Trash2 size={15} /></button>
      </div>
    </div>
  );
}

/** The canvas — the visual hero. 3D visualizer (TogoScene3D, covered in the
 *  chosen fabric/finish) OR the top-down 2D plan with draggable tiles. The 2D
 *  plan is a FIXED cm-sized canvas at SCALE px/cm (the drag math divides pointer
 *  deltas by SCALE) — it is NEVER rescaled; on small screens it lives in an
 *  `overflow-auto` box so it pans instead. Heights make it large on every size. */
function CanvasArea({
  view, vm, scene3d, material, svgById, selectedUid, setSelectedUid, codeByUid, placed,
  onTileDown, onTileMove, onTileUp, hoveredPieceId, setHoveredPieceId, onRotatePiece, onDeletePiece, onMeshFootprint,
}) {
  const [hoveredUid, setHoveredUid] = useState(null);
  if (view === '3d') {
    return <TogoScene3D scene3d={scene3d} material={material} onMeshFootprint={onMeshFootprint} className="w-full h-[56vh] min-h-[320px] lg:h-[58vh] lg:min-h-[440px] rounded-xl border border-ink-200 overflow-hidden bg-ink-50/40" />;
  }
  const enter = (t) => { setHoveredUid(t.uid); setHoveredPieceId?.(t.pieceId); };
  const leave = () => { setHoveredUid(null); setHoveredPieceId?.(null); };
  return (
    <div className="overflow-auto rounded-xl border border-ink-200 bg-ink-50/40 h-[56vh] min-h-[320px] lg:h-[58vh] lg:min-h-[440px]">
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
        {/* Overall assembled dimensions — measures the used area (top run + the
            run coming down), live as pieces move. */}
        <PlanDimensions tiles={vm.tiles} />

        {vm.tiles.map((t) => {
          const sel = t.uid === selectedUid;
          // Linked-highlight: hovering this model in the palette (or another of
          // its instances) rings every placed instance, and vice-versa.
          const linked = !sel && hoveredPieceId != null && t.pieceId === hoveredPieceId;
          const code = codeByUid[t.uid];
          const showControls = t.uid === hoveredUid || sel;
          return (
            <div
              key={t.uid}
              onPointerDown={(e) => onTileDown(e, placed.find((p) => p.uid === t.uid))}
              onPointerMove={onTileMove}
              onPointerUp={onTileUp}
              onMouseEnter={() => enter(t)}
              onMouseLeave={leave}
              className={['absolute touch-none cursor-grab active:cursor-grabbing select-none', sel ? 'z-20' : 'z-10'].join(' ')}
              style={{ left: t.leftPx, top: t.topPx, width: t.wPx, height: t.hPx }}
            >
              <div className={['absolute inset-0 rounded-md', sel ? 'ring-2 ring-brand-500 bg-brand-500/5' : linked ? 'ring-2 ring-brand-300 bg-brand-500/5' : 'ring-1 ring-transparent hover:ring-ink-300'].join(' ')} />
              <div className="absolute top-1/2 left-1/2 text-ink-800" style={{ width: t.innerWPx, height: t.innerHPx, transform: `translate(-50%, -50%) rotate(${t.rot}deg)` }} dangerouslySetInnerHTML={{ __html: fillSvg(svgById[t.pieceId]) }} />
              <span className="absolute left-1/2 -translate-x-1/2 bottom-0.5 inline-flex items-center gap-1 rounded bg-ink-900/70 text-white text-[9px] leading-none px-1 py-0.5 tabular-nums pointer-events-none">
                {code && <img src={swatchUrl(code)} alt="" className="w-2.5 h-2.5 rounded-sm object-cover" />}
                {t.dimsLabel}
              </span>

              {/* On-plan contextual controls — appear on hover/selection right
                  under the piece, so rotate/delete is one click away (no trip to
                  the toolbar). stopPropagation keeps a click off the drag/deselect. */}
              {showControls && (
                <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-30 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
                  <button type="button" title="Rotar" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRotatePiece(t.uid); }} className="w-7 h-7 grid place-items-center rounded-full bg-surface shadow-pop border border-ink-200 text-ink-700 hover:bg-ink-50"><RotateCw size={14} /></button>
                  <button type="button" title="Quitar" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDeletePiece(t.uid); }} className="w-7 h-7 grid place-items-center rounded-full bg-surface shadow-pop border border-ink-200 text-red-600 hover:bg-red-50"><Trash2 size={14} /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Overall-assembly dimension lines for the 2D plan — a width run along the top
 *  and a depth run down the left of the bounding box of all placed pieces, each
 *  labelled in cm. Pure overlay (px = cm at SCALE 1), non-interactive, recomputed
 *  every render so it tracks the layout as pieces are added/moved/rotated. */
function PlanDimensions({ tiles }) {
  if (!tiles || tiles.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.leftPx); minY = Math.min(minY, t.topPx);
    maxX = Math.max(maxX, t.leftPx + t.wPx); maxY = Math.max(maxY, t.topPx + t.hPx);
  }
  const w = Math.round(maxX - minX), d = Math.round(maxY - minY);
  const yT = Math.max(11, minY - 16);   // width dimension line (above the layout)
  const xL = Math.max(11, minX - 16);   // depth dimension line (left of the layout)
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return (
    <svg className="absolute inset-0 z-[6] pointer-events-none overflow-visible text-brand-600" width="100%" height="100%" aria-hidden>
      <g strokeOpacity="0.65">
        <line x1={minX} y1={yT} x2={maxX} y2={yT} stroke="currentColor" strokeWidth="1" />
        <line x1={minX} y1={yT - 4} x2={minX} y2={yT + 4} stroke="currentColor" strokeWidth="1" />
        <line x1={maxX} y1={yT - 4} x2={maxX} y2={yT + 4} stroke="currentColor" strokeWidth="1" />
        <line x1={xL} y1={minY} x2={xL} y2={maxY} stroke="currentColor" strokeWidth="1" />
        <line x1={xL - 4} y1={minY} x2={xL + 4} y2={minY} stroke="currentColor" strokeWidth="1" />
        <line x1={xL - 4} y1={maxY} x2={xL + 4} y2={maxY} stroke="currentColor" strokeWidth="1" />
      </g>
      <rect x={cx - 25} y={yT - 8} width="50" height="15" rx="3" fill="white" fillOpacity="0.92" />
      <text x={cx} y={yT + 3} textAnchor="middle" fontSize="10" fontWeight="600" fill="currentColor">{w} cm</text>
      <g transform={`rotate(-90 ${xL} ${cy})`}>
        <rect x={xL - 25} y={cy - 8} width="50" height="15" rx="3" fill="white" fillOpacity="0.92" />
        <text x={xL} y={cy + 3} textAnchor="middle" fontSize="10" fontWeight="600" fill="currentColor">{d} cm</text>
      </g>
    </svg>
  );
}

/** The quote summary — a sheet listing every placed piece with its swatch (hover
 *  a swatch to see it big), unit price, the assembled size, the running total,
 *  and the "request a quote" CTA. Read-only over `placed` (the same data the
 *  lead submission and the estimate dock use). */
function QuoteSheet({ open, onClose, placed, resolvedById, svgById, rates, subtotalUsd, pending = 0, overallCm, onRequest }) {
  const [preview, setPreview] = useState(null); // hovered swatch → big centered preview
  useEffect(() => { if (!open) setPreview(null); }, [open]);
  const rows = placed.map((p) => {
    const r = resolvePlacement(p, resolvedById);
    return { uid: p.uid, pieceId: p.pieceId, label: r.label || r.name || 'Togo', w: r.widthCm, d: r.depthCm, fabric: p.material?.fabric || '', code: p.material?.code || '', priced: !!p.material, price: r.unitPrice };
  });
  return (
    <Modal open={open} onClose={onClose} title="Resumen de tu Togo" size="lg">
      {open && (
        <>
        <div className="space-y-3">
          {!rows.length && <p className="text-sm text-ink-500 py-6 text-center">Aún no has agregado piezas a tu sofá.</p>}
          {rows.length > 0 && (
            <ul className="divide-y divide-ink-100 -my-1">
              {rows.map((row) => (
                <li key={row.uid} className="flex items-center gap-3 py-2.5">
                  <span className="shrink-0 w-12 h-12 rounded-lg bg-ink-50 text-ink-700 p-1.5 grid place-items-center" dangerouslySetInnerHTML={{ __html: svgById[row.pieceId] || '' }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{row.label}</div>
                    <div className="text-[11px] text-ink-500 tabular-nums">{row.w}×{row.d} cm</div>
                    {row.fabric && <div className="text-[11px] text-ink-500 truncate">{row.fabric}</div>}
                  </div>
                  {row.code && (
                    <img
                      src={swatchUrl(row.code)} alt={row.fabric}
                      className="shrink-0 w-10 h-10 rounded-md object-cover border border-ink-200 cursor-zoom-in"
                      onMouseEnter={() => setPreview({ code: row.code, fabric: row.fabric })}
                      onMouseLeave={() => setPreview(null)}
                    />
                  )}
                  <div className="shrink-0 w-28 text-right text-sm">
                    {row.priced
                      ? (row.price != null ? <span className="font-medium tabular-nums">{formatMoney(row.price, 'USD', rates)}</span> : <span className="text-ink-400">sin precio</span>)
                      : <span className="text-[11px] text-ink-400">Elige una tela</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-ink-200 pt-3">
              <div className="min-w-0">
                <div className="text-[10px] text-ink-500 uppercase tracking-wide">Estimado · {rows.length} pieza{rows.length === 1 ? '' : 's'}</div>
                <div className="text-lg font-display font-semibold tabular-nums">{formatMoney(subtotalUsd, 'USD', rates)}</div>
                {pending > 0 && <div className="text-[11px] text-amber-600">{pending} sin tela — elige una para incluirla</div>}
                {overallCm?.widthCm > 0 && <div className="text-[11px] text-ink-500 tabular-nums">Conjunto: {overallCm.widthCm} × {overallCm.depthCm} cm</div>}
              </div>
              <button type="button" onClick={onRequest} className="btn-primary text-sm shrink-0">Solicitar cotización <ArrowRight size={15} /></button>
            </div>
          )}
        </div>
        {preview && createPortal(
          <div className="fixed inset-0 z-[90] pointer-events-none flex items-center justify-center p-4">
            <div className="bg-surface rounded-2xl shadow-pop border border-ink-200 p-2">
              <img src={swatchUrl(preview.code)} alt={preview.fabric} className="w-64 h-64 sm:w-72 sm:h-72 rounded-xl object-cover" />
              {preview.fabric && <div className="mt-1.5 text-center text-xs text-ink-700">{preview.fabric}</div>}
            </div>
          </div>,
          document.body,
        )}
        </>
      )}
    </Modal>
  );
}

/** Mobile bottom sheet — a `fixed inset-x-0 bottom-0 rounded-t-2xl` panel that
 *  slides up over a dimmed backdrop. Portaled to <body> (like Modal) so an
 *  ancestor `transform`/`opacity` can't re-base its `position: fixed` or tint
 *  it. Tap the backdrop or the X to dismiss; body scroll locks while open. Used
 *  for the Piezas and Material menus so the controls never crowd the canvas. */
function BottomSheet({ open, onClose, title, children }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-150" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-lg bg-surface shadow-pop border-x border-t border-ink-100/60 rounded-t-2xl max-h-[82vh] flex flex-col pb-[env(safe-area-inset-bottom)] animate-in slide-in-from-bottom-4 duration-200">
        <div className="pt-3 pb-1 flex justify-center" aria-hidden>
          <div className="w-10 h-[3px] rounded-full bg-ink-200" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100">
          <h2 className="font-display text-base font-semibold text-ink-900 leading-snug pr-3 min-w-0">{title}</h2>
          <button onClick={onClose} className="btn-icon -mr-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100" aria-label="Cerrar"><X size={18} aria-hidden /></button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-4 py-4 flex-1 min-w-0">{children}</div>
      </div>
    </div>,
    document.body,
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

function RequestForm({ storeName, items, estimateUsd, total, onBack, onDone }) {
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
          <p className="text-xs text-ink-500 mt-0.5">{storeName} te contactará con el precio final y la disponibilidad. Estimado: <b className="text-ink-700 tabular-nums">{total}</b></p>
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
