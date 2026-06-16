import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sofa, RotateCw, Trash2, Plus, Loader2, Eraser, ArrowRight } from 'lucide-react';
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
import { TOGO_PIECES } from '../assets/togo/pieces.js';

// The five Togo plan symbols, inlined (?raw) so we can recolor the strokes
// (stroke=currentColor) and overlay them; the WASM that produced them never
// ships — these committed SVGs are the whole client-side asset.
import svgChauf from '../assets/togo/togo_chauf.svg?raw';
import svgA from '../assets/togo/togo_a.svg?raw';
import svgGb from '../assets/togo/togo_gb.svg?raw';
import svgMc from '../assets/togo/togo_mc.svg?raw';
import svgLounge from '../assets/togo/togo_lounge.svg?raw';

const SVG_BY_ID = { chauf: svgChauf, a: svgA, gb: svgGb, mc: svgMc, lounge: svgLounge };
const BINDINGS_KEY = 'rs.togo.bindings';
const SCALE = PX_PER_CM; // 1 px per cm

function loadBindings() {
  try { return JSON.parse(localStorage.getItem(BINDINGS_KEY) || '{}') || {}; } catch { return {}; }
}

/** Best-effort: the first "Togo …" catalog family whose name matches this piece. */
function autoRoot(piece, togoFamilies) {
  const keys = (piece.match || []).filter((k) => k !== 'togo');
  for (const fam of togoFamilies) {
    const n = (fam.name || '').toLowerCase();
    if (keys.some((k) => k && n.includes(k))) return fam.root;
  }
  return null;
}

export default function TogoConfigurator() {
  const navigate = useNavigate();
  const { profileId, settings, currentProfile } = useApp();

  const products = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  const families = useMemo(() => {
    const m = new Map();
    for (const f of groupFamilies(products)) m.set(f.root, f);
    return m;
  }, [products]);
  const togoFamilies = useMemo(
    () => [...families.values()].filter((f) => /togo/i.test(f.name || '')).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [families],
  );

  // Per-piece catalog binding: { root, grade, manualPrice }. Persisted locally so
  // the dealer sets Togo prices once. No DB write, no migration.
  const [bindings, setBindings] = useState(loadBindings);
  useEffect(() => { try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings)); } catch { /* ignore */ } }, [bindings]);
  const setBinding = useCallback((pieceId, patch) => {
    setBindings((b) => ({ ...b, [pieceId]: { ...b[pieceId], ...patch } }));
  }, []);

  // Resolve each piece → its render + price facts, merging the live catalog.
  const resolvedById = useMemo(() => {
    const out = {};
    for (const piece of TOGO_PIECES) {
      const b = bindings[piece.id] || {};
      const root = b.root != null ? b.root : autoRoot(piece, togoFamilies);
      const fam = root ? families.get(root) : null;
      let unitPrice = null; let reference = ''; let name = piece.label; let subtype = ''; let dimensions = '';
      if (fam) {
        const grade = fam.graded ? (b.grade || fam.grades[0]) : '';
        const p = productForGrade(fam, grade);
        if (p) {
          unitPrice = Number(p.priceUsd) || 0;
          reference = p.reference || '';
          name = p.name || fam.name || piece.label;
          subtype = grade ? composeSubtype(grade, '') : (p.subtype || '');
          dimensions = p.dimensions || '';
        }
      } else if (b.manualPrice != null && b.manualPrice !== '') {
        unitPrice = Number(b.manualPrice) || 0;
      }
      out[piece.id] = {
        ...piece, svgId: piece.id, root: root || null,
        grade: fam && fam.graded ? (b.grade || fam.grades[0]) : '',
        unitPrice, reference, name, subtype,
        dimensions: dimensions || `${piece.widthCm}×${piece.depthCm} cm`,
      };
    }
    return out;
  }, [bindings, togoFamilies, families]);

  // Placed pieces on the plan + selection.
  const [placed, setPlaced] = useState([]);
  const [selectedUid, setSelectedUid] = useState(null);

  const vm = useMemo(() => resolveConfigurator(placed, resolvedById, { scale: SCALE }), [placed, resolvedById]);
  const rates = useMemo(() => effectiveRates(settings), [settings]);

  // Add a piece near the plan corner, cascading so successive adds don't stack.
  const addPiece = useCallback((pieceId) => {
    const r = resolvedById[pieceId]; if (!r) return;
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
    setPlaced((prev) => [...prev, { uid, pieceId, x: c.x, y: c.y, rot: 0 }]);
    setSelectedUid(uid);
  }, [resolvedById, placed]);

  const rotateSel = useCallback(() => {
    setPlaced((prev) => prev.map((p) => {
      if (p.uid !== selectedUid) return p;
      const r = resolvedById[p.pieceId]; const rot = (p.rot + 90) % 360; const fp = footprintOf(r, rot);
      return { ...p, rot, ...clampToPlan(p.x, p.y, fp.w, fp.h) };
    }));
  }, [selectedUid, resolvedById]);

  const deleteSel = useCallback(() => {
    setPlaced((prev) => prev.filter((p) => p.uid !== selectedUid));
    setSelectedUid(null);
  }, [selectedUid]);

  // Keyboard: R rotate · Delete remove · Esc deselect. Ignored while typing.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      if (!selectedUid && e.key !== 'Escape') return;
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateSel(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
      else if (e.key === 'Escape') setSelectedUid(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedUid, rotateSel, deleteSel]);

  // Pointer drag of a placed tile. We capture the pointer to the tile, convert
  // client deltas → cm, then snap (against the other tiles) + clamp.
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
        const rr = resolvedById[p.pieceId]; const f = footprintOf(rr, p.rot);
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
        <div>
          <h1 className="font-display font-semibold text-lg leading-tight">Configurador Togo</h1>
          <p className="text-xs text-ink-500">Arrastra piezas en planta · arma el sofá · crea la cotización.</p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-5 items-start">
        {/* Palette + per-piece price binding */}
        <aside className="card card-pad space-y-3">
          <h2 className="text-sm font-display font-semibold">Piezas</h2>
          {!togoFamilies.length && (
            <p className="text-[11px] text-ink-500 leading-relaxed">
              No hay modelos «Togo» en el catálogo, así que cada pieza usa un precio manual.
              Impórtalos en Catálogos para precios por grado.
            </p>
          )}
          <ul className="space-y-2.5">
            {TOGO_PIECES.map((piece) => {
              const r = resolvedById[piece.id];
              const fam = r.root ? families.get(r.root) : null;
              return (
                <li key={piece.id} className="rounded-xl border border-ink-100 p-2.5">
                  <button
                    type="button"
                    onClick={() => addPiece(piece.id)}
                    className="w-full flex items-center gap-3 text-left group"
                    title="Agregar a la planta"
                  >
                    <span
                      className="shrink-0 w-14 h-14 rounded-lg bg-ink-50 text-ink-700 p-1 grid place-items-center group-hover:bg-brand-50 group-hover:text-brand-700 transition-colors"
                      dangerouslySetInnerHTML={{ __html: SVG_BY_ID[piece.id] }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium truncate">{piece.label}</span>
                      <span className="block text-[11px] text-ink-500 tabular-nums">{piece.widthCm}×{piece.depthCm} cm</span>
                      <span className="block text-[11px] font-medium text-ink-700 tabular-nums">
                        {r.unitPrice != null ? formatMoney(r.unitPrice, 'USD', rates) : 'sin precio'}
                      </span>
                    </span>
                    <Plus size={16} className="shrink-0 text-ink-400 group-hover:text-brand-600" aria-hidden />
                  </button>

                  {/* Price binding: a catalog model (+ grade) or a manual price. */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <select
                      className="input h-8 text-[11px] py-0 flex-1 min-w-[7rem]"
                      value={r.root || ''}
                      onChange={(e) => setBinding(piece.id, { root: e.target.value || null })}
                      aria-label={`Modelo para ${piece.label}`}
                    >
                      <option value="">Precio manual…</option>
                      {togoFamilies.map((f) => (
                        <option key={f.root} value={f.root}>{f.name}</option>
                      ))}
                    </select>
                    {fam && fam.graded ? (
                      <select
                        className="input h-8 text-[11px] py-0 w-16"
                        value={r.grade || ''}
                        onChange={(e) => setBinding(piece.id, { grade: e.target.value })}
                        aria-label={`Grado para ${piece.label}`}
                      >
                        {fam.grades.map((g) => <option key={g} value={g}>{g}</option>)}
                      </select>
                    ) : !fam ? (
                      <input
                        type="number" min="0" step="1"
                        className="input h-8 text-[11px] py-0 w-24"
                        placeholder="US$"
                        value={bindings[piece.id]?.manualPrice ?? ''}
                        onChange={(e) => setBinding(piece.id, { manualPrice: e.target.value })}
                        aria-label={`Precio manual para ${piece.label}`}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Plan canvas + dock */}
        <section className="space-y-3 min-w-0">
          <div className="card card-pad">
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="text-[11px] text-ink-500">
                {vm.count ? `${vm.count} pieza(s) · clic para seleccionar, arrastra para mover` : 'Agrega piezas desde la izquierda'}
              </span>
              <div className="flex items-center gap-1.5">
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

            {/* The plan. Fixed cm extent → px via SCALE; scrolls on small screens. */}
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
                  return (
                    <div
                      key={t.uid}
                      onPointerDown={(e) => onTileDown(e, placed.find((p) => p.uid === t.uid))}
                      onPointerMove={onTileMove}
                      onPointerUp={onTileUp}
                      className={[
                        'absolute touch-none cursor-grab active:cursor-grabbing select-none',
                        sel ? 'z-20' : 'z-10',
                      ].join(' ')}
                      style={{ left: t.leftPx, top: t.topPx, width: t.wPx, height: t.hPx }}
                      title={`${t.label}${t.priceUsd ? ` · ${formatMoney(t.priceUsd, 'USD', rates)}` : ''}`}
                    >
                      <div className={['absolute inset-0 rounded-md', sel ? 'ring-2 ring-brand-500 bg-brand-500/5' : 'ring-1 ring-transparent hover:ring-ink-300'].join(' ')} />
                      <div
                        className={['absolute top-1/2 left-1/2', t.hasPrice ? 'text-ink-800' : 'text-red-400'].join(' ')}
                        style={{
                          width: t.innerWPx, height: t.innerHPx,
                          transform: `translate(-50%, -50%) rotate(${t.rot}deg)`,
                        }}
                        dangerouslySetInnerHTML={{ __html: SVG_BY_ID[t.pieceId] }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Totals + create. Subtotal === compoundSubtotal of the line we'd create. */}
          <div className="card card-pad flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] text-ink-500 uppercase tracking-wide">Subtotal ({vm.count} pieza{vm.count === 1 ? '' : 's'})</div>
              <div className="text-xl font-display font-semibold tabular-nums">{formatMoney(vm.subtotalUsd, 'USD', rates)}</div>
              <div className="text-xs text-ink-500 tabular-nums">{formatMoney(vm.subtotalUsd, 'DOP', rates)}</div>
              {!vm.priced && vm.count > 0 && (
                <div className="text-[11px] text-amber-600 mt-0.5">Asigna precio a cada pieza para un total completo.</div>
              )}
            </div>
            <button
              type="button"
              onClick={createQuote}
              disabled={!vm.count || creating}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {creating ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
              Crear cotización
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
