import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Sofa, RotateCw, Trash2, Plus, Loader2, Eraser, ArrowRight, Palette } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { groupFamilies, productForGrade } from '../lib/catalog.js';
import { composeSubtype } from '../lib/subtype.js';
import { formatMoney } from '../lib/format.js';
import { LINE_KIND_ITEM } from '../lib/constants.js';
import {
  effectiveRates, initialQuoteTerms,
  resolveConfigurator, snapPlacement, footprintOf, clampToPlan, buildTogoModularSeed,
  PLAN_W_CM, PLAN_H_CM, PX_PER_CM,
} from '../core/quote/index.js';
import SwatchPicker from '../components/quote-builder/SwatchPicker.jsx';
import ImageView from '../components/ImageView.jsx';

const SCALE = PX_PER_CM;

export default function TogoConfigurator() {
  const navigate = useNavigate();
  const { profileId, settings, currentProfile } = useApp();

  // The dealer-managed picture catalog (uploaded in /admin/catalog/togo).
  const models = useLiveQuery(
    () => (profileId ? db.togoModels.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  const activeModels = useMemo(
    () => (models || []).filter((m) => m.active !== false && m.svg)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || '')),
    [models],
  );
  const products = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  const families = useMemo(() => {
    const m = new Map();
    for (const f of groupFamilies(products)) m.set(f.root, f);
    return m;
  }, [products]);

  const svgById = useMemo(() => {
    const o = {};
    for (const m of activeModels) o[m.id] = m.svg;
    return o;
  }, [activeModels]);

  // Each model → its base render + price facts (cheapest grade when bound).
  const resolvedById = useMemo(() => {
    const out = {};
    for (const m of activeModels) {
      const fam = m.productRoot ? families.get(m.productRoot) : null;
      let unitPrice = null; let reference = ''; let name = m.name; let subtype = ''; let dimensions = '';
      if (fam) {
        const grade = fam.graded ? fam.grades[0] : '';
        const p = productForGrade(fam, grade);
        if (p) {
          unitPrice = Number(p.priceUsd) || 0;
          reference = p.reference || '';
          name = p.name || fam.name || m.name;
          subtype = grade ? composeSubtype(grade, '') : (p.subtype || '');
          dimensions = p.dimensions || '';
        }
      }
      out[m.id] = {
        id: m.id, label: m.name, name, reference, subtype,
        widthCm: m.widthCm, depthCm: m.depthCm, root: m.productRoot || null,
        unitPrice, dimensions: dimensions || `${m.widthCm}×${m.depthCm} cm`,
      };
    }
    return out;
  }, [activeModels, families]);

  const [placed, setPlaced] = useState([]);
  const [selectedUid, setSelectedUid] = useState(null);
  const [hoveredId, setHoveredId] = useState(null); // model id, links palette ⇄ canvas
  const [matOpen, setMatOpen] = useState(false);

  const vm = useMemo(() => resolveConfigurator(placed, resolvedById, { scale: SCALE }), [placed, resolvedById]);
  const rates = useMemo(() => effectiveRates(settings), [settings]);
  const selected = placed.find((p) => p.uid === selectedUid) || null;
  const selectedFamily = selected ? families.get(resolvedById[selected.pieceId]?.root) : null;

  const addPiece = useCallback((modelId) => {
    const r = resolvedById[modelId]; if (!r) return;
    const fp = footprintOf(r, 0);
    const base = 40 + (placed.length % 6) * 26;
    const start = clampToPlan(base, base, fp.w, fp.h);
    const others = placed.map((p) => {
      const f = footprintOf(resolvedById[p.pieceId], p.rot);
      return { x: p.x, y: p.y, w: f.w, h: f.h };
    });
    const snapped = snapPlacement({ x: start.x, y: start.y, w: fp.w, h: fp.h }, others);
    const c = clampToPlan(snapped.x, snapped.y, fp.w, fp.h);
    const uid = newId();
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

  const deleteSel = useCallback(() => {
    setPlaced((prev) => prev.filter((p) => p.uid !== selectedUid));
    setSelectedUid(null);
  }, [selectedUid]);

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      if (matOpen) return;
      if (!selectedUid && e.key !== 'Escape') return;
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateSel(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
      else if (e.key === 'Escape') setSelectedUid(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedUid, rotateSel, deleteSel, matOpen]);

  // Pointer drag of a placed tile (cm deltas → snap → clamp).
  const dragRef = useRef(null);
  const onTileDown = useCallback((e, p) => {
    e.stopPropagation();
    setSelectedUid(p.uid);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { uid: p.uid, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
  }, []);
  const onTileMove = useCallback((e) => {
    const d = dragRef.current; if (!d) return;
    const r = resolvedById[placed.find((p) => p.uid === d.uid)?.pieceId];
    if (!r) return;
    setPlaced((prev) => {
      const me = prev.find((p) => p.uid === d.uid); if (!me) return prev;
      const fp = footprintOf(r, me.rot);
      const nx = d.ox + (e.clientX - d.sx) / SCALE;
      const ny = d.oy + (e.clientY - d.sy) / SCALE;
      const others = prev.filter((p) => p.uid !== d.uid).map((p) => {
        const f = footprintOf(resolvedById[p.pieceId], p.rot);
        return { x: p.x, y: p.y, w: f.w, h: f.h };
      });
      const snapped = snapPlacement({ x: nx, y: ny, w: fp.w, h: fp.h }, others);
      const c = clampToPlan(snapped.x, snapped.y, fp.w, fp.h);
      return prev.map((p) => (p.uid === d.uid ? { ...p, x: c.x, y: c.y } : p));
    });
  }, [placed, resolvedById]);
  const onTileUp = useCallback((e) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  // Material pick for the selected piece → reprice by grade + stamp swatch.
  const onPickMaterial = useCallback((pick) => {
    if (!selected) return;
    // Reprice by grade when the model is bound to a graded product; otherwise the
    // fabric/swatch is cosmetic and the (model) price is left untouched.
    const p = selectedFamily ? productForGrade(selectedFamily, pick.grade) : null;
    setPlaced((prev) => prev.map((row) => (row.uid === selected.uid ? {
      ...row,
      material: {
        grade: pick.grade, fabric: pick.fabric, swatchImageId: pick.swatchImageId ?? null,
        subtype: composeSubtype(pick.grade, pick.fabric),
        reference: p?.reference || '',
        unitPrice: p && p.priceUsd != null ? Number(p.priceUsd) || 0 : (resolvedById[row.pieceId]?.unitPrice ?? null),
      },
    } : row)));
  }, [selected, selectedFamily, resolvedById]);

  const [creating, setCreating] = useState(false);
  const createQuote = useCallback(async () => {
    if (!placed.length || creating) return;
    setCreating(true);
    try {
      const id = newId();
      const defaults = {
        id, profileId, createdByUserId: currentProfile?.id || null, number: null,
        customerId: null, professionalId: null, commissionPct: null,
        orderType: 'floor', orderId: null, status: 'draft', currencyCode: 'USD',
        rates: effectiveRates(settings),
        marginPct: settings?.defaultMarginPct || 0, discountPct: settings?.defaultDiscountPct || 0,
        shipping: 0, terms: initialQuoteTerms(settings, 'floor'), notes: '',
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      await assignSequenceNumber({
        table: 'quotes', profileId, start: 1001,
        build: (number) => ({ ...defaults, number, updatedAt: Date.now() }),
      });
      const seed = buildTogoModularSeed(placed, resolvedById, newId);
      await db.quoteLines.put({
        id: newId(), quoteId: id, kind: LINE_KIND_ITEM, sortOrder: 0,
        family: seed.family, reference: '', name: seed.name, subtype: '',
        dimensions: '', description: '', productDescription: '', pageRef: '',
        imageId: null, qty: 1, unitPrice: 0, unitCost: null,
        lineMarginPct: 0, lineDiscountPct: 0, priceMin: null, priceMax: null,
        notes: '', components: seed.components,
        isOptional: false, optionalOffered: false, materialOptions: null,
      });
      navigate(`/quotes/${id}`);
    } catch (e) {
      console.error('[togo] could not create quote', e);
      setCreating(false);
    }
  }, [placed, creating, profileId, currentProfile, settings, resolvedById, navigate]);

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-2.5">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-brand-50 text-brand-600">
          <Sofa size={18} aria-hidden />
        </span>
        <div className="flex-1">
          <h1 className="font-display font-semibold text-lg leading-tight">Configurador Togo</h1>
          <p className="text-xs text-ink-500">Arrastra piezas en planta · elige telas · crea la cotización.</p>
        </div>
        <Link to="/admin/catalog/togo" className="btn-ghost text-xs">Gestionar modelos</Link>
      </header>

      {activeModels.length === 0 ? (
        <div className="card card-pad text-center py-12">
          <Sofa size={26} className="mx-auto text-ink-300 mb-3" />
          <h2 className="font-display font-semibold text-sm">Aún no hay modelos Togo</h2>
          <p className="text-xs text-ink-500 mt-1.5 max-w-sm mx-auto">
            Sube el DWG de cada pieza en el catálogo Togo para empezar a configurar.
          </p>
          <Link to="/admin/catalog/togo" className="btn-primary text-sm mt-4 inline-flex"><Plus size={15} /> Ir al catálogo Togo</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-5 items-start">
          {/* Picture catalog */}
          <aside className="card card-pad space-y-2.5">
            <h2 className="text-sm font-display font-semibold">Piezas</h2>
            <ul className="space-y-2">
              {activeModels.map((m) => {
                const r = resolvedById[m.id];
                const hot = hoveredId === m.id;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => addPiece(m.id)}
                      onMouseEnter={() => setHoveredId(m.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      className={[
                        'w-full flex items-center gap-3 text-left rounded-xl border p-2.5 transition-colors',
                        hot ? 'border-brand-400 bg-brand-50/60' : 'border-ink-100 hover:bg-ink-50',
                      ].join(' ')}
                      title="Agregar a la planta"
                    >
                      <span className="shrink-0 w-14 h-14 rounded-lg bg-ink-50 text-ink-700 p-1 grid place-items-center" dangerouslySetInnerHTML={{ __html: m.svg }} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium truncate">{m.name}</span>
                        <span className="block text-[11px] text-ink-500 tabular-nums">{m.widthCm}×{m.depthCm} cm</span>
                        <span className="block text-[11px] font-medium text-ink-700 tabular-nums">
                          {r.unitPrice != null ? formatMoney(r.unitPrice, 'USD', rates) : 'sin precio · vincula un producto'}
                        </span>
                      </span>
                      <Plus size={16} className="shrink-0 text-ink-400" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* Plan canvas + dock */}
          <section className="space-y-3 min-w-0">
            <div className="card card-pad">
              <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                <span className="text-[11px] text-ink-500">
                  {!vm.count
                    ? 'Agrega piezas desde la izquierda'
                    : (selected && !selectedFamily)
                      ? <span className="text-amber-600">Pieza sin producto vinculado — la tela no cambiará el precio. Vincúlala en el catálogo Togo.</span>
                      : selected
                        ? 'Elige «Tela» para vestir la pieza · R rota · Supr quita'
                        : `${vm.count} pieza(s) · clic para seleccionar, arrastra para mover`}
                </span>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => setMatOpen(true)} disabled={!selectedUid} className="btn-ghost text-xs disabled:opacity-40" title={selectedUid ? 'Elegir tela' : 'Selecciona una pieza primero'}>
                    <Palette size={14} /> Tela
                  </button>
                  <button type="button" onClick={rotateSel} disabled={!selectedUid} className="btn-ghost text-xs disabled:opacity-40" title="Rotar 90° (R)">
                    <RotateCw size={14} /> Rotar
                  </button>
                  <button type="button" onClick={deleteSel} disabled={!selectedUid} className="btn-ghost text-xs text-red-600 disabled:opacity-40" title="Eliminar (Supr)">
                    <Trash2 size={14} /> Quitar
                  </button>
                  <button type="button" onClick={() => { setPlaced([]); setSelectedUid(null); }} disabled={!vm.count} className="btn-ghost text-xs disabled:opacity-40" title="Vaciar la planta">
                    <Eraser size={14} /> Vaciar
                  </button>
                </div>
              </div>

              <div className="overflow-auto rounded-xl border border-ink-200 bg-ink-50/40">
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
                    const hot = hoveredId === t.pieceId;
                    return (
                      <div
                        key={t.uid}
                        onPointerDown={(e) => onTileDown(e, placed.find((p) => p.uid === t.uid))}
                        onPointerMove={onTileMove}
                        onPointerUp={onTileUp}
                        onMouseEnter={() => setHoveredId(t.pieceId)}
                        onMouseLeave={() => setHoveredId(null)}
                        className={['absolute touch-none cursor-grab active:cursor-grabbing select-none', sel ? 'z-20' : 'z-10'].join(' ')}
                        style={{ left: t.leftPx, top: t.topPx, width: t.wPx, height: t.hPx }}
                      >
                        <div className={['absolute inset-0 rounded-md transition-shadow',
                          sel ? 'ring-2 ring-brand-500 bg-brand-500/5'
                            : hot ? 'ring-2 ring-brand-300' : 'ring-1 ring-transparent hover:ring-ink-300'].join(' ')} />
                        <div
                          className={[t.hasPrice ? 'text-ink-800' : 'text-red-400', 'absolute top-1/2 left-1/2'].join(' ')}
                          style={{ width: t.innerWPx, height: t.innerHPx, transform: `translate(-50%, -50%) rotate(${t.rot}deg)` }}
                          dangerouslySetInnerHTML={{ __html: svgById[t.pieceId] }}
                        />
                        {/* Dimensions + fabric chip — integrated into the preview. */}
                        <span className="absolute left-1/2 -translate-x-1/2 bottom-0.5 inline-flex items-center gap-1 rounded bg-ink-900/70 text-white text-[9px] leading-none px-1 py-0.5 tabular-nums pointer-events-none">
                          {t.swatchImageId && <ImageView id={t.swatchImageId} alt="" className="w-2.5 h-2.5 rounded-sm object-cover" />}
                          {t.dimsLabel}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="card card-pad flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[11px] text-ink-500 uppercase tracking-wide">Subtotal ({vm.count} pieza{vm.count === 1 ? '' : 's'})</div>
                <div className="text-xl font-display font-semibold tabular-nums">{formatMoney(vm.subtotalUsd, 'USD', rates)}</div>
                <div className="text-xs text-ink-500 tabular-nums">{formatMoney(vm.subtotalUsd, 'DOP', rates)}</div>
                {!vm.priced && vm.count > 0 && (
                  <div className="text-[11px] text-amber-600 mt-0.5">Vincula o asigna tela a cada pieza para un total completo.</div>
                )}
              </div>
              <button type="button" onClick={createQuote} disabled={!vm.count || creating} className="btn-primary text-sm disabled:opacity-50">
                {creating ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                Crear cotización
              </button>
            </div>
          </section>
        </div>
      )}

      <SwatchPicker
        open={matOpen}
        onClose={() => setMatOpen(false)}
        onSelect={onPickMaterial}
        family={selectedFamily}
        currentGrade={selected?.material?.grade}
        currentFabric={selected?.material?.fabric}
        showPalette={false}
      />
    </div>
  );
}
