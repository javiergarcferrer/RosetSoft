import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Sofa, RotateCw, Trash2, Loader2, Eraser, ArrowRight, ArrowLeft, Check, AlertCircle, Palette, Layers, X, FileDown, Box, Square, View, Receipt, Undo2, Redo2, CopyPlus, Lightbulb } from 'lucide-react';
import { formatMoney } from '../../lib/format.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import { productForGrade } from '../../lib/catalog.js';
import { composeSubtype, composeFabricLabel } from '../../lib/subtype.js';
import { downloadText } from '../../lib/csv.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { buildTogoGroup, disposeGroup, STANDARD_TOGO_FINISH } from '../../components/togo/togoSceneBuilder.js';
import { loadTogoModels } from '../../components/togo/togoModelLoader.js';
import { fetchTogoCatalog, submitTogoRequest, togoEmbedModalUrl } from '../../lib/togoEmbed.js';
import { useMeshPlans } from '../../components/togo/useMeshPlans.js';
import { useTogoThumbnails, useTogoFabricThumbs } from '../../components/togo/togoThumbnails.js';
import {
  resolveConfigurator, resolvePlacement, snapPlacement, footprintOf, clampToPlan, PX_PER_CM,
  resolveTogoDxf, placementsFromPlaced, resolveTogoScene, scenePlacementsFromPlaced,
  createHistory, historyPush, historyUndo, historyRedo,
  firstWithoutFabric, duplicatePlacement,
} from '../../core/quote/index.js';
import { TOGO_PIECES } from '../../assets/togo/pieces.js';
import togoHeroSvg from '../../assets/togo/togo_gb.svg?raw';
import togoWireA from '../../assets/togo/togo_a.svg?raw';
import togoWireChauf from '../../assets/togo/togo_chauf.svg?raw';
import togoWireMc from '../../assets/togo/togo_mc.svg?raw';
import togoWireLounge from '../../assets/togo/togo_lounge.svg?raw';
import togoWirePb from '../../assets/togo/togo_pb.svg?raw';
import Modal from '../../components/Modal.jsx';
import MaterialColorPicker from '../../components/quote-builder/MaterialColorPicker.jsx';
import ImageView from '../../components/ImageView.jsx';
import TogoStage from '../../components/togo/TogoStage.jsx';
import TogoArViewer from '../../components/togo/TogoArViewer.jsx';

const SCALE = PX_PER_CM;

// The clean bundled Togo line wireframes, keyed by piece id. Used as each model's
// palette image where one fits; pieces with no good bundled match (Loveseat,
// Ottoman) fall through to their OWN stored plan svg (togo_pb / togo_p). togo_gb
// is the hero import reused here.
// `togo_pb` = the Loveseat plan with its baked-in "Togo_pb" label STRIPPED.
const TOGO_WIRES = { a: togoWireA, chauf: togoWireChauf, gb: togoHeroSvg, mc: togoWireMc, lounge: togoWireLounge, pb: togoWirePb };
const WIRE_BY_FOOTPRINT = new Map(TOGO_PIECES.map((p) => [`${p.widthCm}x${p.depthCm}`, p.id]));
// Map a real dealer model to a wireframe by NAME (most specific first; `togo_a`
// is the diagonal CORNER plan, `togo_pb` the clean Loveseat). Ottoman is absent
// → wireframeFor returns null → caller uses the model's own svg (togo_p).
const WIRE_NAME_ALIAS = [
  [/corner|angle|esquin|rincon/, 'a'],
  [/medium|large|grand|3\s*plaz/, 'mc'],
  [/lounge|meridi|chaise/, 'lounge'],
  [/love|biplaza/, 'pb'],
  [/fireside|chauff|chofesa|sin\s*brazo/, 'chauf'],
  [/sofa|settee|canap/, 'gb'],
  [/armchair|sillon|fauteuil|butaca/, 'a'],
];

function wireframeFor(model) {
  if (!model) return null;
  const name = String(model.name || '').toLowerCase();
  if (/ottoman|pouf|puff|repos|tabur/.test(name)) return null;   // use its own plan svg
  let id = WIRE_NAME_ALIAS.find(([re]) => re.test(name))?.[1];
  if (!id) {
    const fp = `${Math.round(model.widthCm)}x${Math.round(model.depthCm)}`;
    id = WIRE_BY_FOOTPRINT.get(fp)
      || TOGO_PIECES.find((p) => p.match.some((k) => k !== 'togo' && name.includes(k)))?.id;
  }
  return (id && TOGO_WIRES[id]) || null;
}


// A touch of "game juice": a haptic tap on key actions. Guarded — a no-op where
// the device/browser doesn't support vibration (desktop, iOS Safari), so it only
// ever *adds* feel, never errors. Patterns are deliberately tiny (ms).
const buzz = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } };

// Smoothly tween a displayed number toward its target (easeOutCubic) — the live
// estimate ticks up like a score instead of snapping. Interruptible: a new target
// mid-flight re-tweens from wherever it currently is, so rapid edits stay fluid.
// Pure UI sugar over the already-derived total; the real number is unchanged.
function useCountUp(target) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    const to = target;
    if (from === to) { setDisplay(to); return undefined; }
    let raf = 0; let start = null;
    const dur = 520;
    const step = (t) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = from + (to - from) * eased;
      fromRef.current = cur; setDisplay(cur);
      if (p < 1) raf = requestAnimationFrame(step);
      else { fromRef.current = to; setDisplay(to); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return display;
}

// The Done-screen celebration palette — the ONE place the monochrome Rams skin
// earns colour, because a sent request is the reward moment.
const CONFETTI_COLORS = ['#e2725b', '#2f6f6b', '#d9a441', '#3b5f8a', '#b8553f', '#6c8c5a'];

// First-run hints seen flag (bump the suffix to re-show after a big UX change).
const HINTS_KEY = 'togo:hints:v1';

const newUid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

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

// True when the widget is loaded inside a host fullscreen container (the embed
// snippet's popup overlay or the in-app modal pass `?ctx=modal`) — it then skips
// its own launch card and shows the configurator directly (no card-in-a-card).
function isModalContext() {
  if (typeof window === 'undefined') return false;
  try {
    // ctx=modal can ride the hash (#/embed/togo?ctx=modal) OR the real query
    // (/configurator?ctx=modal, the clean-path entry).
    if (new URLSearchParams(window.location.search || '').get('ctx') === 'modal') return true;
    const h = window.location.hash || '';
    const qi = h.indexOf('?');
    return qi >= 0 && new URLSearchParams(h.slice(qi + 1)).get('ctx') === 'modal';
  } catch { return false; }
}

// The clean standalone configurator page (soft.alcover.do/configurator) is a
// full-screen, top-level document — NOT a small iframe — so it skips the launch
// card and drops straight into the configurator. The launch card exists only to
// give the IFRAME embed a tap-to-open-fullscreen affordance; main.jsx mounts this
// component at /configurator, while the iframe embed loads #/embed/togo (where
// the card still shows). Without this, /configurator showed the card and a tap
// bounced the user out to the hash URL #/embed/togo.
function isStandaloneConfigurator() {
  if (typeof window === 'undefined') return false;
  return /^\/configurator\/?$/.test(window.location.pathname || '');
}

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
  const [hoveredPieceId, setHoveredPieceId] = useState(null); // hover-link plan ⇄ hotbar
  const [quoteOpen, setQuoteOpen] = useState(false); // the quote summary sheet
  const [dlOpen, setDlOpen] = useState(false);   // the download format chooser
  const [objBusy, setObjBusy] = useState(false); // building the 3D OBJ (loads three on demand)
  // Undo/redo over `placed` — one entry per user gesture (add, drag commit,
  // rotate, delete, fabric, clear). The stack mechanics are the pure VM helpers.
  const [hist, setHist] = useState(createHistory);
  // First-run coach line (how to move/rotate/pick fabric) — shown once a piece is
  // down, dismissed forever via localStorage (guarded: iframe storage may be off).
  const [hintsOpen, setHintsOpen] = useState(() => {
    try { return !localStorage.getItem(HINTS_KEY); } catch { return false; }
  });
  const dismissHints = useCallback(() => {
    setHintsOpen(false);
    try { localStorage.setItem(HINTS_KEY, '1'); } catch { /* blocked */ }
  }, []);
  // false → show the launch card; the card opens the configurator in a NEW TAB
  // (?ctx=modal → straight to the build), so it always gets the full screen.
  // The clean /configurator page launches straight in (it's already full-screen).
  const launched = isModalContext() || isStandaloneConfigurator();

  // Dieter Rams skin: while the configurator is mounted, flag <body> so the
  // monochrome variable remap (index.css) reaches the portalled modals too.
  useEffect(() => {
    document.body.classList.add('togo-rams');
    return () => document.body.classList.remove('togo-rams');
  }, []);
  // ONE standard velvet (terciopelo) for every piece — no per-finish editor. The
  // only customer choice left is the FABRIC (colour) via the swatch picker.
  const material = STANDARD_TOGO_FINISH;

  useEffect(() => {
    let active = true;
    fetchTogoCatalog()
      .then((d) => { if (active) setCat({ status: 'ready', data: d, error: null }); })
      .catch((e) => { if (active) setCat({ status: 'error', data: null, error: e?.message || 'Error' }); });
    return () => { active = false; };
  }, []);

  const data = cat.data;
  const rates = data?.rates || { USD: 1, DOP: 60 };
  // FBX-only: the configurator is built entirely from the 3D models. We show only
  // pieces that have a mesh (their plan + footprint come from it). The `|| all`
  // guard keeps the widget from going blank if a catalogue has no meshes yet.
  const models = useMemo(() => {
    const all = data?.models || [];
    const withMesh = all.filter((m) => m.mesh?.url);
    return withMesh.length ? withMesh : all.filter((m) => m.svg);
  }, [data]);
  const materials = useMemo(() => data?.materials || [], [data]);

  // A mesh-backed piece derives BOTH its plan SVG and its footprint straight from
  // the FBX (`useMeshPlans` → meshToPlan): the 2D tile is literally the model seen
  // from above, so it can never disagree with the 3D. The mesh loads async, so
  // until it resolves we fall back to the stored plan/dims.
  // Load a mesh only once its piece is actually on the plan — the palette uses the
  // light stored thumbnail, so a visitor never pulls FBX bytes for a piece they
  // don't place. The tile shows the stored fallback for the instant it takes the
  // mesh to resolve, then swaps to the exact top-down silhouette.
  const meshEntries = useMemo(() => {
    const used = new Set(placed.map((p) => p.pieceId));
    return models.filter((m) => m.mesh?.url && used.has(m.id)).map((m) => ({ id: m.id, url: m.mesh.url, upAxis: m.mesh.upAxis }));
  }, [models, placed]);
  const meshPlans = useMeshPlans(meshEntries);
  const svgById = useMemo(
    () => Object.fromEntries(models.map((m) => [m.id, meshPlans[m.id]?.svg || m.svg])),
    [models, meshPlans],
  );
  // Each model's catalogue IMAGE (palette, start screen, summary): the bundled
  // wireframe where one fits, else the model's own stored plan svg (Loveseat
  // togo_pb, Ottoman togo_p). Crisped at thumbnail size by non-scaling strokes.
  const thumbById = useMemo(
    () => Object.fromEntries(models.map((m) => [m.id, wireframeFor(m) || m.svg])),
    [models],
  );
  // Rendered PERSPECTIVE thumbnails (real FBX, studio rig) keyed by model id —
  // the modern catalogue image; falls back to the wireframe svg while a render
  // is still in flight or if the model has no mesh.
  const renderThumbById = useTogoThumbnails(models);

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

  // Resume the in-progress build across reloads/returns — a faster end-to-end flow
  // (a customer doesn't rebuild from scratch). Third-party-iframe storage may be
  // blocked, so everything is guarded; restored rows are filtered to models that
  // still exist. Cleared when the plan is emptied or the request is sent.
  const buildKey = useMemo(() => `togo:build:${data?.storeName || 'default'}`, [data?.storeName]);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !models.length) return;
    restoredRef.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(buildKey) || 'null');
      const ids = new Set(models.map((m) => m.id));
      const rows = (Array.isArray(saved?.placed) ? saved.placed : []).filter((p) => p && ids.has(p.pieceId));
      if (rows.length) setPlaced(rows);
    } catch { /* blocked / corrupt → start fresh */ }
  }, [models, buildKey]);
  useEffect(() => {
    if (!restoredRef.current) return;   // never write before the first restore attempt
    try {
      if (placed.length) localStorage.setItem(buildKey, JSON.stringify({ placed, at: Date.now() }));
      else localStorage.removeItem(buildKey);
    } catch { /* ignore */ }
  }, [placed, buildKey]);

  // ── History plumbing: every user mutation goes through commitPlaced, which
  // snapshots the previous state (one undo entry per gesture). The restore-from-
  // localStorage path above deliberately bypasses it (nothing to undo TO).
  const placedRef = useRef(placed);
  useEffect(() => { placedRef.current = placed; }, [placed]);
  const commitPlaced = useCallback((next) => {
    const prev = placedRef.current;
    const value = typeof next === 'function' ? next(prev) : next;
    if (value === prev) return;
    setHist((h) => historyPush(h, prev));
    setPlaced(value);
    placedRef.current = value;
  }, []);
  const undo = useCallback(() => {
    const u = historyUndo(hist, placedRef.current);
    if (!u) return;
    buzz(7);
    setHist(u.hist); setPlaced(u.present); placedRef.current = u.present;
  }, [hist]);
  const redo = useCallback(() => {
    const r = historyRedo(hist, placedRef.current);
    if (!r) return;
    buzz(7);
    setHist(r.hist); setPlaced(r.present); placedRef.current = r.present;
  }, [hist]);
  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;

  const resolvedById = useMemo(() => {
    const o = {};
    for (const m of models) {
      const mp = meshPlans[m.id];        // the FBX footprint wins over catalogue dims
      o[m.id] = {
        id: m.id, label: m.name,
        widthCm: mp?.widthCm ?? m.widthCm,
        depthCm: mp?.depthCm ?? m.depthCm,
        unitPrice: m.priceUsd, root: m.family?.root || m.root || null,
        offeredKeys: m.offeredFabricKeys || [],
        mesh: m.mesh || null,
      };
    }
    return o;
  }, [models, meshPlans]);


  const vm = useMemo(() => resolveConfigurator(placed, resolvedById, { scale: SCALE }), [placed, resolvedById]);
  const scene3d = useMemo(() => resolveTogoScene(scenePlacementsFromPlaced(placed, resolvedById)), [placed, resolvedById]);
  const selected = placed.find((p) => p.uid === selectedUid) || null;
  const selectedFamily = selected ? (families.get(resolvedById[selected.pieceId]?.root) || null) : null;
  const selResolved = selected ? resolvePlacement(selected, resolvedById) : null;

  // Togo's price depends on the fabric GRADE, so a piece has no real price until
  // a fabric is chosen: the estimate sums ONLY fabric-chosen pieces (the rest
  // read "Elige una tela"), and the palette shows no price at all. USD throughout.
  const pricedUsd = useMemo(
    () => placed.reduce((s, p) => s + (p.material ? (Number(p.material.unitPrice) || 0) : 0), 0),
    [placed],
  );
  const pendingFabric = useMemo(() => placed.filter((p) => !p.material).length, [placed]);
  // The estimate ticks up like a score; the CTA "breathes" once there's a real,
  // priced quote to send (a piece down AND a fabric chosen).
  const animatedUsd = useCountUp(pricedUsd);
  const quoteReady = vm.count > 0 && pricedUsd > 0;

  const addPiece = useCallback((modelId) => {
    const r = resolvedById[modelId]; if (!r) return;
    const fp = footprintOf(r, 0);
    const others = placed.map((p) => { const f = footprintOf(resolvedById[p.pieceId], p.rot); return { x: p.x, y: p.y, w: f.w, h: f.h }; });
    // Drop the new piece FLUSH against the RIGHTMOST piece, top-aligned to THAT
    // piece — so a sectional builds out as a connected row that always touches,
    // never floats (aligning to the global top could leave it clear of every
    // neighbour in an L-shape) and never stacks. The strong edge-snap then keeps
    // it locked, and the user can drag to rearrange. First piece → default spot.
    let x = 40, y = 40;
    if (others.length) {
      const right = others.reduce((a, o) => (o.x + o.w > a.x + a.w ? o : a));
      x = right.x + right.w; y = right.y;
    }
    const start = clampToPlan(x, y, fp.w, fp.h);
    const snapped = snapPlacement({ x: start.x, y: start.y, w: fp.w, h: fp.h }, others);
    const c = clampToPlan(snapped.x, snapped.y, fp.w, fp.h);
    const uid = newUid();
    commitPlaced([...placed, { uid, pieceId: modelId, x: c.x, y: c.y, rot: 0 }]);
    setSelectedUid(uid);
    buzz(11);
  }, [resolvedById, placed, commitPlaced]);

  // uid-parameterized so the on-plan hover controls can rotate/delete ANY piece
  // (not just the selected one) without a round-trip to the toolbar.
  const rotatePiece = useCallback((uid) => {
    if (uid == null) return;
    buzz(7);
    commitPlaced((prev) => (prev.some((p) => p.uid === uid)
      ? prev.map((p) => {
        if (p.uid !== uid) return p;
        const rot = (p.rot + 90) % 360; const fp = footprintOf(resolvedById[p.pieceId], rot);
        return { ...p, rot, ...clampToPlan(p.x, p.y, fp.w, fp.h) };
      })
      : prev));
  }, [resolvedById, commitPlaced]);
  const deletePiece = useCallback((uid) => {
    if (uid == null) return;
    buzz([4, 26, 7]);
    commitPlaced((prev) => (prev.some((p) => p.uid === uid) ? prev.filter((p) => p.uid !== uid) : prev));
    setSelectedUid((s) => (s === uid ? null : s));
  }, [commitPlaced]);
  const rotateSel = useCallback(() => rotatePiece(selectedUid), [rotatePiece, selectedUid]);
  const deleteSel = useCallback(() => deletePiece(selectedUid), [deletePiece, selectedUid]);
  // Duplicate the selected piece (same rotation + fabric), dropped flush beside it.
  const duplicateSel = useCallback(() => {
    if (!selectedUid) return;
    const r = duplicatePlacement(placedRef.current, selectedUid, resolvedById, newUid());
    if (!r) return;
    buzz(11);
    commitPlaced(r.placed);
    setSelectedUid(r.uid);
  }, [selectedUid, resolvedById, commitPlaced]);

  // Material pick for the selected piece → reprice by grade + stamp swatch/subtype.
  const onPickMaterial = useCallback((pick) => {
    if (!selected) return;
    buzz(9);
    const p = selectedFamily ? productForGrade(selectedFamily, pick.grade) : null;
    commitPlaced((prev) => prev.map((row) => (row.uid === selected.uid ? {
      ...row,
      material: {
        grade: pick.grade, fabric: pick.fabric, code: pick.code || '', swatchImageId: null,
        subtype: composeSubtype(pick.grade, pick.fabric),
        reference: p?.reference || '',
        unitPrice: p && p.priceUsd != null ? Number(p.priceUsd) : (resolvedById[row.pieceId]?.unitPrice ?? null),
      },
    } : row)));
  }, [selected, selectedFamily, resolvedById, commitPlaced]);

  // Apply ONE fabric to EVERY piece, repricing each by its OWN bound model.
  const applyFabricToAll = useCallback((pick) => {
    buzz([7, 18, 11]);
    commitPlaced((prev) => prev.map((row) => {
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
  }, [families, resolvedById, commitPlaced]);

  const clearFabric = useCallback(() => {
    if (!selectedUid) return;
    commitPlaced((prev) => prev.map((row) => (row.uid === selectedUid ? { ...row, material: undefined } : row)));
  }, [selectedUid, commitPlaced]);

  // "N sin tela" → jump to the first piece missing a fabric and open the picker
  // for it — the warning becomes ONE tap to fix instead of a hunt.
  const fixPendingFabric = useCallback(() => {
    const uid = firstWithoutFabric(placedRef.current);
    if (!uid) return;
    setSelectedUid(uid);
    setMatMode('one');
    setMatOpen(true);
  }, []);
  // Same jump from the Resumen sheet's per-row "Elige una tela".
  const pickFabricFor = useCallback((uid) => {
    if (!uid) return;
    setQuoteOpen(false);
    setSelectedUid(uid);
    setMatMode('one');
    setMatOpen(true);
  }, []);

  // Download the plan as CAD (DXF) — opens in AutoCAD and every plan tool. A
  // genuine differentiator: consumer sofa configurators stop at PDF/image, so a
  // designer-grade, real-cm layout handed straight to the customer's architect.
  const downloadDxf = useCallback(() => {
    if (!placed.length) return;
    const placements = placementsFromPlaced(placed, resolvedById, svgById);
    const { dxf, filename } = resolveTogoDxf(placements, { name: data?.storeName || 'Togo' });
    downloadText(filename, dxf);
  }, [placed, resolvedById, svgById, data?.storeName]);

  // Download the assembled sofa as a 3D OBJ — the same scene the 3D view builds
  // (real FBX meshes where wired, else procedural), exported via three's
  // OBJExporter. Geometry in cm, true-to-size; opens in Blender/3ds Max/SketchUp/
  // AutoCAD and re-exports to FBX. three + the exporter load on demand (only when
  // a visitor actually downloads), so the configurator pays nothing for it.
  const downloadObj = useCallback(async () => {
    if (!placed.length || objBusy) return;
    setObjBusy(true);
    try {
      const [THREE, rbg, objx] = await Promise.all([
        safeDynamicImport(() => import('three')),
        safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
        safeDynamicImport(() => import('three/examples/jsm/exporters/OBJExporter.js')),
      ]);
      const { cache, modelFor } = await loadTogoModels(scene3d);
      const group = buildTogoGroup({ THREE, RoundedBoxGeometry: rbg.RoundedBoxGeometry }, scene3d, { modelFor });
      group.updateMatrixWorld(true);
      const obj = new objx.OBJExporter().parse(group);
      disposeGroup(group);
      cache.forEach((m) => disposeGroup(m.object || m)); // free the source meshes
      downloadText(`${(data?.storeName || 'Togo').replace(/\s+/g, '-')}-togo.obj`, obj);
      setDlOpen(false);
    } catch { /* export unavailable on this device */ }
    setObjBusy(false);
  }, [placed, scene3d, data?.storeName, objBusy]);

  const openMaterial = useCallback((mode) => {
    if (mode === 'one' && !selectedUid) return;
    if (mode === 'all' && !placed.length) return;
    setMatMode(mode);
    setMatOpen(true);
  }, [selectedUid, placed.length]);

  // The 3D stage commits a piece's new plan position on drop (the snap/clamp ran
  // inside the stage against the live layout). One drag = one undo entry; a drop
  // back on the exact same spot records nothing.
  const movePiece = useCallback((uid, x, y) => {
    commitPlaced((prev) => {
      const me = prev.find((p) => p.uid === uid);
      if (!me || (me.x === x && me.y === y)) return prev;
      return prev.map((p) => (p.uid === uid ? { ...p, x, y } : p));
    });
  }, [commitPlaced]);

  // Desktop niceties (2D build only): ⌘/Ctrl+Z undo, ⌘/Ctrl+Shift+Z / Ctrl+Y
  // redo, Delete/Backspace removes the selected piece. Ignored while typing.
  const keysRef = useRef({});
  keysRef.current = { undo, redo, deleteSel, active: step === 'build' && !matOpen && !quoteOpen && !arOpen && !dlOpen };
  useEffect(() => {
    const onKey = (e) => {
      const k = keysRef.current;
      if (!k.active) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === 'z') { e.preventDefault(); if (e.shiftKey) k.redo(); else k.undo(); }
        else if (key === 'y') { e.preventDefault(); k.redo(); }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        k.deleteSel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The launch card — what the embed shows FIRST. Tapping it opens the
  // configurator in a NEW TAB (full screen, no iframe limits). Skipped when this
  // IS that new tab (?ctx=modal) — then we render the configurator directly.
  if (!launched) return <EmbedLaunchCard storeName={data?.storeName} href={togoEmbedModalUrl()} />;

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

  // The configurator is ONE full-bleed window into the build. The canvas fills
  // the frame edge-to-edge; every tool floats over it as a glass HUD cluster —
  // no header bar, no sidebar, no dropdown. Top corners hold view + tools; a
  // single bottom "control deck" holds the piece hotbar, the contextual
  // selected-piece controls, and the live estimate + quote CTA.
  return (
    <div className="fixed inset-0 overflow-hidden bg-surface text-ink-900">
      {/* The stage — a window into the Togo. */}
      <CanvasArea
        fill
        view={view} placed={placed} resolvedById={resolvedById} material={material}
        selectedUid={selectedUid} onSelect={setSelectedUid} onMove={movePiece} onRotate={rotateSel}
        models={models} onAddPiece={addPiece} thumbById={thumbById} renderThumbById={renderThumbById}
        overallCm={vm.overallCm}
      />

      {/* ── Top-left: brand + 2D/3D toggle + undo/redo ── */}
      <div className="absolute top-[max(0.75rem,env(safe-area-inset-top))] left-[max(0.75rem,env(safe-area-inset-left))] z-30 flex items-center gap-2">
        <div className="hud-panel hidden sm:flex items-center gap-1.5 px-2.5 py-1.5">
          <Sofa size={15} className="text-brand-500" aria-hidden />
          <span className="font-display font-semibold text-sm leading-none">Togo</span>
        </div>
        <div className="hud-panel inline-flex overflow-hidden">
          <button type="button" onClick={() => setView('2d')} aria-pressed={view === '2d'} className={`px-3 py-2 text-xs inline-flex items-center gap-1 transition ${view === '2d' ? 'bg-brand-500 text-white' : 'text-ink-600 hover:bg-ink-100/60'}`}><Square size={13} /> 2D</button>
          <button type="button" onClick={() => setView('3d')} aria-pressed={view === '3d'} className={`px-3 py-2 text-xs inline-flex items-center gap-1 transition ${view === '3d' ? 'bg-brand-500 text-white' : 'text-ink-600 hover:bg-ink-100/60'}`}><Box size={13} /> 3D</button>
        </div>
        {view === '2d' && (canUndo || canRedo) && (
          <div className="hud-panel inline-flex overflow-hidden">
            <button type="button" onClick={undo} disabled={!canUndo} title="Deshacer" aria-label="Deshacer" className="px-2.5 py-2 text-ink-700 transition hover:bg-ink-100/60 active:scale-90 disabled:opacity-30 disabled:active:scale-100"><Undo2 size={15} /></button>
            <button type="button" onClick={redo} disabled={!canRedo} title="Rehacer" aria-label="Rehacer" className="px-2.5 py-2 text-ink-700 transition hover:bg-ink-100/60 active:scale-90 disabled:opacity-30 disabled:active:scale-100"><Redo2 size={15} /></button>
          </div>
        )}
      </div>

      {/* ── Top-right: tools, each its own floating button (no dropdown) ── */}
      {vm.count > 0 && (
        <div className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-30 flex items-center gap-1.5">
          <HudIcon title="Una tela para todas" onClick={() => openMaterial('all')}><Layers size={15} /></HudIcon>
          <HudIcon title="Resumen de tu Togo" onClick={() => setQuoteOpen(true)}><Receipt size={15} /></HudIcon>
          <HudIcon title="Ver en tu espacio" onClick={() => setArOpen(true)}><View size={15} /></HudIcon>
          <HudIcon title="Descargar (DXF / OBJ)" onClick={() => setDlOpen(true)}><FileDown size={15} /></HudIcon>
          <HudIcon title="Vaciar el plano" danger onClick={() => { buzz([4, 26, 7]); commitPlaced([]); setSelectedUid(null); }}><Eraser size={15} /></HudIcon>
        </div>
      )}

      {/* ── Selected-piece header — a compact card pinned at the TOP, just below
           the tool buttons (2D editing only). Its rotate control lives on the
           canvas beneath the piece itself (see RotateDock). ── */}
      {view === '2d' && selected && selResolved && (
        <div className="absolute top-[3.75rem] inset-x-0 z-20 px-3 flex justify-center pointer-events-none">
          <div className="w-full max-w-md">
            <SelectedStrip
              selected={selected} selResolved={selResolved} selectedFamily={selectedFamily}
              thumbById={thumbById} renderThumbById={renderThumbById} rates={rates}
              onPickFabric={() => openMaterial('one')} onClearFabric={clearFabric}
              onDelete={deleteSel}
            />
          </div>
        </div>
      )}

      {/* ── Bottom control deck — the build hotbar and the live estimate + quote
           CTA. The wrapper is click-through (pointer-events-none); only the glass
           panels catch input, so the canvas stays draggable in the gaps. ── */}
      <div className="absolute inset-x-0 bottom-0 z-20 pointer-events-none">
        <div className="mx-auto w-full max-w-5xl flex flex-col items-stretch gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">

          {/* The build tool: the piece hotbar (add pieces). Shown in 2D where the
              plan is editable; 3D is a look-only preview, so no tool here. */}
          {view === '2d' && (
            <PieceHotbar models={models} thumbById={thumbById} renderThumbById={renderThumbById} onAdd={addPiece} hoveredPieceId={hoveredPieceId} onHover={setHoveredPieceId} />
          )}

          {/* Live estimate + the single primary CTA. */}
          <div className="hud-panel pointer-events-auto flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              {vm.count === 0 ? (
                <div className="text-sm text-ink-500">Agrega piezas para empezar tu Togo</div>
              ) : (
                <>
                  <div className="text-[11px] text-ink-500">Estimado · {vm.count} pieza{vm.count === 1 ? '' : 's'}{pendingFabric > 0 && pricedUsd > 0 ? ` · ${pendingFabric} sin tela` : ''}</div>
                  {pricedUsd > 0
                    ? <div className="text-xl sm:text-2xl font-display font-semibold tabular-nums tracking-tight leading-none mt-0.5">{formatMoney(Math.round(animatedUsd), 'USD', rates)}</div>
                    : <div className="text-sm text-ink-500 leading-tight py-0.5">Elige una tela para ver el precio</div>}
                  {vm.overallCm.widthCm > 0 && <div className="text-[11px] text-ink-500 tabular-nums mt-0.5">Conjunto {vm.overallCm.widthCm} × {vm.overallCm.depthCm} cm</div>}
                </>
              )}
            </div>
            <button type="button" onClick={() => { buzz(9); setStep('form'); }} disabled={!vm.count} className={`btn-primary text-sm disabled:opacity-50 shrink-0 ${quoteReady ? 'togo-ready' : ''}`}>
              Cotizar <ArrowRight size={15} />
            </button>
          </div>
        </div>
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

      <TogoArViewer open={arOpen} onClose={() => setArOpen(false)} scene3d={scene3d} material={material} storeName={data.storeName} />

      <DownloadSheet
        open={dlOpen} onClose={() => setDlOpen(false)}
        onDxf={() => { downloadDxf(); setDlOpen(false); }} onObj={downloadObj} objBusy={objBusy}
      />

      <QuoteSheet
        open={quoteOpen} onClose={() => setQuoteOpen(false)}
        placed={placed} resolvedById={resolvedById} models={models} thumbById={thumbById} renderThumbById={renderThumbById} rates={rates}
        subtotalUsd={pricedUsd} pending={pendingFabric} overallCm={vm.overallCm}
        onRequest={() => { setQuoteOpen(false); setStep('form'); }}
      />
    </div>
  );
}

/** A floating glass tool button — the top-right HUD cluster. Icon-only with a
 *  native tooltip; no dropdown, every action is one tap. */
/** A model's catalogue image: the rendered perspective PNG when ready, else the
 *  line wireframe svg. One component so the picker, hotbar and selected header
 *  all show the same modern representation. */
function ModelThumb({ id, render = {}, svg = '', className = '', alt = '' }) {
  const url = render[id];
  if (url) return <img src={url} alt={alt} draggable={false} className={`${className} object-contain select-none`} />;
  return (
    <span
      className={`${className} block text-ink-700 [&>svg]:w-full [&>svg]:h-full [&_*]:[vector-effect:non-scaling-stroke] [&_*]:[stroke-width:1.1px]`}
      dangerouslySetInnerHTML={{ __html: svg || '' }}
    />
  );
}

function HudIcon({ title, onClick, danger = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`hud-panel w-9 h-9 grid place-items-center transition active:scale-90 hover:bg-ink-100/60 ${danger ? 'text-red-600' : 'text-ink-700'}`}
    >
      {children}
    </button>
  );
}

/** The piece hotbar — a floating, horizontally-scrollable strip of Togo pieces,
 *  like a game's build palette. Tap a tile and it springs onto the plan. The
 *  tile rings when its placed instances are hovered on the plan (and vice-versa),
 *  so the link between palette and canvas reads instantly. Replaces the old
 *  sidebar list + "Agregar pieza" sheet: the build tool lives ON the canvas. */
function PieceHotbar({ models, thumbById = {}, renderThumbById = {}, onAdd, hoveredPieceId, onHover }) {
  return (
    <div className="hud-panel pointer-events-auto self-center max-w-full overflow-x-auto no-scrollbar">
      <div className="flex items-stretch gap-1.5 p-1.5">
        {models.map((m) => {
          const hot = hoveredPieceId != null && m.id === hoveredPieceId;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onAdd(m.id)}
              onMouseEnter={() => onHover?.(m.id)}
              onMouseLeave={() => onHover?.(null)}
              title={`Agregar ${m.name}`}
              className={`group shrink-0 w-[74px] rounded-xl border p-1.5 flex flex-col items-center gap-1 transition active:scale-95 ${hot ? 'border-brand-400 bg-brand-50/70 ring-1 ring-brand-300' : 'border-ink-100 hover:bg-ink-50 active:bg-ink-100'}`}
            >
              <ModelThumb id={m.id} render={renderThumbById} svg={thumbById[m.id] || m.svg} alt={m.name} className="w-14 h-12" />
              <span className="block w-full text-[10px] leading-none text-ink-600 text-center truncate">{m.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Selected-piece strip — thumbnail, label, fabric swatch, price, dims + the
 *  per-piece actions (Tela / clear-fabric / rotate / delete). `compact` packs
 *  it onto one floating row for the mobile contextual bar. */
function SelectedStrip({ selected, selResolved, selectedFamily, thumbById = {}, renderThumbById = {}, rates, onPickFabric, onClearFabric, onDelete }) {
  return (
    <div className="hud-panel pointer-events-auto flex items-center gap-2.5 pl-1.5 pr-1.5 py-1.5 togo-rise">
      <ModelThumb id={selected.pieceId} render={renderThumbById} svg={thumbById[selected.pieceId]} alt={selResolved.label} className="shrink-0 w-11 h-11 rounded-lg bg-ink-50/60" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-display font-semibold leading-tight truncate">{selResolved.label}</div>
        <div className="text-[11px] text-ink-500 flex items-center gap-1.5 leading-tight mt-0.5">
          {selected.material?.code && <ImageView id={null} fallbackUrl={swatchUrl(selected.material.code)} alt="" className="w-3.5 h-3.5 rounded-sm object-cover shrink-0" />}
          <span className="truncate max-w-[42vw]">{selected.material?.fabric || (selectedFamily ? 'Sin tela' : 'Sin opciones')}</span>
          {selected.material && selResolved.unitPrice != null && (
            <span className="tabular-nums font-medium text-ink-700 shrink-0">· {formatMoney(selResolved.unitPrice, 'USD', rates)}</span>
          )}
        </div>
      </div>
      <span className="hidden xs:inline text-[11px] text-ink-400 tabular-nums shrink-0 mr-0.5">{selResolved.widthCm}×{selResolved.depthCm}</span>
      <div className="flex items-center gap-0.5 shrink-0">
        {selectedFamily && (
          <button type="button" onClick={onPickFabric} className="btn-icon" title="Elegir tela"><Palette size={15} /></button>
        )}
        {selected.material && (
          <button type="button" onClick={onClearFabric} className="btn-icon text-ink-500" title="Quitar tela"><X size={15} /></button>
        )}
        <button type="button" onClick={onDelete} className="btn-icon text-red-600" title="Quitar"><Trash2 size={15} /></button>
      </div>
    </div>
  );
}

// Empty-plan starter overlay — a welcoming grid of the AVAILABLE MODELS (each its
// clean Togo wireframe); tap one to drop it onto the plan. Floats over the grid,
// only while the plan is empty.
function EmptyPlanStart({ models = [], thumbById = {}, renderThumbById = {}, onAddPiece }) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center p-4 pointer-events-none">
      <div className="togo-rise pointer-events-auto text-center w-full max-w-md rounded-2xl bg-surface/90 backdrop-blur-sm border border-ink-200 px-5 py-5 shadow-pop">
        <p className="text-sm font-display font-semibold text-ink-800">Empieza tu diseño</p>
        <p className="text-[11px] text-ink-500 mt-0.5">Toca un modelo para agregarlo:</p>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onAddPiece?.(m.id)}
              className="rounded-xl border border-ink-100 hover:border-brand-300 hover:bg-brand-50/50 active:scale-95 p-2 flex flex-col items-center gap-1.5 transition"
            >
              <ModelThumb id={m.id} render={renderThumbById} svg={thumbById[m.id] || m.svg} alt={m.name} className="w-full h-16" />
              <span className="block w-full text-[11px] leading-tight text-ink-700 text-center line-clamp-2">{m.name}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-ink-400 mt-3">o agrégalos desde la barra de abajo.</p>
      </div>
    </div>
  );
}

/** On-plan dimension lines — width bracket above the layout, depth bracket to its
 *  left, each a hairline with end ticks + a cm pill. Drawn from the layout's
 *  screen-space footprint rect (reported by TogoStage). 2D only. */
function PlanDimensions({ rect, overallCm }) {
  const pad = 18, tick = 5;
  let top = rect.y - pad; if (top < 14) top = rect.y + rect.h + pad;  // flip below if no room above
  let left = rect.x - pad; if (left < 14) left = rect.x + rect.w + pad;
  const x2 = rect.x + rect.w, y2 = rect.y + rect.h;
  return (
    <div className="absolute inset-0 pointer-events-none z-[5] text-ink-400">
      <svg className="absolute inset-0 w-full h-full" style={{ overflow: 'visible' }} fill="none" stroke="currentColor" strokeWidth="1">
        {/* width */}
        <line x1={rect.x} y1={top} x2={x2} y2={top} />
        <line x1={rect.x} y1={top - tick} x2={rect.x} y2={top + tick} />
        <line x1={x2} y1={top - tick} x2={x2} y2={top + tick} />
        {/* depth */}
        <line x1={left} y1={rect.y} x2={left} y2={y2} />
        <line x1={left - tick} y1={rect.y} x2={left + tick} y2={rect.y} />
        <line x1={left - tick} y1={y2} x2={left + tick} y2={y2} />
      </svg>
      <span className="absolute -translate-x-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded-full bg-surface/95 border border-ink-200 text-[10px] font-medium tabular-nums text-ink-600 shadow-sm"
        style={{ left: `${rect.x + rect.w / 2}px`, top: `${top}px` }}>{overallCm.widthCm} cm</span>
      <span className="absolute -translate-x-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded-full bg-surface/95 border border-ink-200 text-[10px] font-medium tabular-nums text-ink-600 shadow-sm"
        style={{ left: `${left}px`, top: `${rect.y + rect.h / 2}px` }}>{overallCm.depthCm} cm</span>
    </div>
  );
}

/** The selected piece's silhouette highlight — a thick warm-yellow stroke that
 *  hugs the model, drawn from the perspective-correct on-screen outline TogoStage
 *  computes (CSS-px points). No viewBox: the SVG's user units ARE CSS px, so the
 *  points map 1:1 onto the canvas. A soft amber drop-shadow gives it depth so it
 *  reads as pressed against the seat. */
function ContourOverlay({ points }) {
  if (!points || points.length < 3) return null;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('') + 'Z';
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-[6]" style={{ overflow: 'visible' }} fill="none" aria-hidden>
      <path d={d} stroke="#f5c000" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round"
        style={{ filter: 'drop-shadow(0 1px 2.5px rgba(176,128,0,0.5))' }} />
    </svg>
  );
}

function CanvasArea({
  view, placed, resolvedById, material, selectedUid, onSelect, onMove, onRotate,
  models = [], onAddPiece, thumbById = {}, renderThumbById = {}, overallCm, fill = false,
}) {
  const boxedH = 'h-[56vh] min-h-[320px] lg:h-[58vh] lg:min-h-[440px]';
  const [selPos, setSelPos] = useState(null);
  const [planRect, setPlanRect] = useState(null);
  const [contour, setContour] = useState(null);
  const showRotate = view === '2d' && selectedUid != null && selPos;
  const showDims = view === '2d' && planRect && overallCm?.widthCm > 0;
  return (
    <div className={fill ? 'absolute inset-0 overflow-hidden bg-ink-50/40' : `relative overflow-hidden rounded-xl border border-ink-200 bg-ink-50/40 ${boxedH}`}>
      <TogoStage
        mode={view} placed={placed} resolvedById={resolvedById} material={material}
        selectedUid={selectedUid} onSelect={onSelect} onMove={onMove}
        onSelectedScreenPos={setSelPos} onPlanBounds={setPlanRect} onSelContour={setContour}
        className="absolute inset-0"
      />
      {view === '2d' && <ContourOverlay points={contour} />}
      {showDims && <PlanDimensions rect={planRect} overallCm={overallCm} />}
      {/* Rotate control floating just beneath the tapped piece. */}
      {showRotate && (
        <button
          type="button"
          onClick={onRotate}
          title="Rotar pieza"
          style={{ left: `${selPos.x}px`, top: `${selPos.y + 12}px` }}
          className="absolute z-10 -translate-x-1/2 grid place-items-center w-10 h-10 rounded-full bg-surface/95 backdrop-blur border border-ink-200 text-ink-700 shadow-pop active:scale-90 transition hover:bg-ink-50"
        >
          <RotateCw size={17} />
        </button>
      )}
      {!placed.length && <EmptyPlanStart models={models} thumbById={thumbById} renderThumbById={renderThumbById} onAddPiece={onAddPiece} />}
    </div>
  );
}

/** The quote summary — a sheet listing every placed piece with its swatch (hover
 *  a swatch to see it big), unit price, the assembled size, the running total,
 *  and the "request a quote" CTA. Read-only over `placed` (the same data the
 *  lead submission and the estimate dock use). */
function QuoteSheet({ open, onClose, placed, resolvedById, models = [], thumbById = {}, renderThumbById = {}, rates, subtotalUsd, pending = 0, overallCm, onRequest }) {
  const [preview, setPreview] = useState(null); // hovered swatch → big centered preview
  useEffect(() => { if (!open) setPreview(null); }, [open]);
  const rows = placed.map((p) => {
    const r = resolvePlacement(p, resolvedById);
    return { uid: p.uid, pieceId: p.pieceId, label: r.label || r.name || 'Togo', w: r.widthCm, d: r.depthCm, fabric: p.material?.fabric || '', code: p.material?.code || '', priced: !!p.material, price: r.unitPrice };
  });
  // Render each fabricked row in its CHOSEN fabric (sampled swatch hue), so the
  // Resumen thumbnail matches the placed piece. Only while the sheet is open.
  const modelById = useMemo(() => Object.fromEntries(models.map((m) => [m.id, m])), [models]);
  const fabricRows = open ? rows.filter((row) => row.code).map((row) => ({
    key: row.uid, code: row.code,
    model: modelById[row.pieceId] || { id: row.pieceId, widthCm: row.w, depthCm: row.d, name: row.label },
  })) : [];
  const fabricThumbs = useTogoFabricThumbs(fabricRows);
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
                  <ModelThumb id={row.uid} render={{ [row.uid]: fabricThumbs[row.uid] || renderThumbById[row.pieceId] }} svg={thumbById[row.pieceId]} alt={row.label} className="shrink-0 w-12 h-12 rounded-lg bg-ink-50 p-1" />
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


function nameFilterOf(keys) {
  return Array.isArray(keys) && keys.length ? new Set(keys) : undefined;
}

/** The download chooser — pick the format: the 2D plan (DXF, for CAD) or the 3D
 *  model (OBJ, for Blender/3ds Max/SketchUp, re-exportable to FBX). Two clear
 *  options, no cramped dropdown. */
function DownloadSheet({ open, onClose, onDxf, onObj, objBusy }) {
  return (
    <Modal open={open} onClose={onClose} title="Descargar tu Togo" size="sm">
      {open && (
        <div className="space-y-2.5">
          <button type="button" onClick={onDxf} className="w-full flex items-center gap-3 rounded-xl border border-ink-200 p-3 text-left hover:bg-ink-50 active:bg-ink-100 transition">
            <span className="shrink-0 w-10 h-10 rounded-lg bg-ink-900 text-white grid place-items-center"><FileDown size={18} /></span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink-900">Plano 2D · DXF</span>
              <span className="block text-[11px] text-ink-500">Para AutoCAD y planos arquitectónicos · cm, escala 1:1.</span>
            </span>
          </button>
          <button type="button" onClick={onObj} disabled={objBusy} className="w-full flex items-center gap-3 rounded-xl border border-ink-200 p-3 text-left hover:bg-ink-50 active:bg-ink-100 transition disabled:opacity-60">
            <span className="shrink-0 w-10 h-10 rounded-lg bg-ink-900 text-white grid place-items-center"><Box size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink-900">Modelo 3D · OBJ</span>
              <span className="block text-[11px] text-ink-500">El sofá armado para Blender, 3ds Max, SketchUp… (re-exporta a FBX).</span>
            </span>
            {objBusy && <Loader2 size={16} className="animate-spin text-ink-400 shrink-0" />}
          </button>
        </div>
      )}
    </Modal>
  );
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

/** The embed's first screen: a full-bleed brand hero — a REAL Togo (the top-down
 *  plan silhouette, channels and all), the "Togo Configurator" wordmark in
 *  Rauschen, an eyebrow in Söhne and the tagline in Lausanne. Edge-to-edge on the
 *  warm canvas so it fills the frame (no sea of white). Tapping it opens the
 *  configurator in a NEW TAB (`?ctx=modal` → straight to the build, full screen).
 *  Shown by every surface that loads the embed route. */
function EmbedLaunchCard({ storeName, href }) {
  const innerRef = useRef(null);
  // The card fills its frame (warm, centered) so there's never a WHITE band. When
  // inside a host iframe it ALSO reports its CONTENT height so the self-sizing
  // snippet shrink-wraps the iframe to exactly the card — no dead space at all.
  // (Measuring the inner block, padding included, makes that fixed-point stable.)
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    let inIframe = false;
    try { inIframe = window.self !== window.top; } catch { inIframe = true; }
    if (!inIframe) return undefined;
    const post = () => {
      try { window.parent?.postMessage({ type: 'togo-embed-height', height: Math.ceil(el.offsetHeight) }, '*'); } catch { /* no listener */ }
    };
    post();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(post) : null;
    ro?.observe(el);
    const t = setTimeout(post, 400);   // re-post once fonts/SVG settle
    return () => { ro?.disconnect(); clearTimeout(t); };
  }, []);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      onClick={() => buzz(12)}
      className="group no-underline text-center bg-[#f4f1ec] text-ink-900 px-6 min-h-screen flex flex-col items-center justify-center"
    >
      <span ref={innerRef} className="togo-rise flex flex-col items-center w-full max-w-sm mx-auto py-10">
        <span className="eyebrow text-ink-400">Ligne Roset</span>
        <span
          className="block w-full max-w-[17rem] text-ink-800 mt-3 [&>svg]:w-full [&>svg]:h-auto"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: togoHeroSvg }}
        />
        <span className="block font-wordmark text-[1.85rem] sm:text-4xl leading-none tracking-tight mt-5">Togo Configurator</span>
        <span className="block font-sans text-sm text-ink-500 mt-3 max-w-xs leading-relaxed">Arma tu sofá modular, pruébalo en distintas telas y recibe tu cotización al instante.</span>
        <span className="inline-flex items-center gap-2 mt-7 rounded-full bg-ink-900 text-white px-6 py-3 text-sm group-hover:bg-ink-800 group-active:scale-[0.98] transition">
          Empezar a diseñar <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
        </span>
        {storeName && <span className="block font-wordmark text-lg text-ink-400 mt-5 leading-none">{storeName}</span>}
      </span>
    </a>
  );
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
      buzz([12, 40, 16, 40, 22]); // a little celebratory rumble on send
      onDone();
    } catch (err) {
      setError(err?.message || 'No se pudo enviar. Intenta de nuevo.');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-surface text-ink-900 p-4 grid place-items-center">
      <form onSubmit={submit} className="togo-rise w-full max-w-md rounded-2xl border border-ink-200 bg-surface p-5 space-y-3.5">
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

/** The reward screen. A confetti burst + a spring-in check make "request sent"
 *  feel like clearing a level, not submitting a form. */
function DoneScreen({ storeName, onReset }) {
  return (
    <div className="relative min-h-full overflow-hidden bg-surface text-ink-900 p-6 grid place-items-center">
      <Confetti />
      <div className="togo-rise relative z-10 text-center max-w-sm space-y-3">
        <div className="togo-pop w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 inline-flex items-center justify-center"><Check size={30} /></div>
        <h2 className="font-display font-semibold text-xl">¡Solicitud enviada!</h2>
        <p className="text-sm text-ink-500">{storeName} recibió tu diseño y te contactará pronto con el precio final y la disponibilidad.</p>
        <button type="button" onClick={onReset} className="btn-ghost text-sm">Diseñar otro</button>
      </div>
    </div>
  );
}

/** A pure-CSS confetti burst — each bit reads its own randomized trajectory from
 *  inline custom properties (no animation library, no canvas). Memoized so it's
 *  cut once per mount; honors reduced-motion via the .togo-confetti CSS guard. */
function Confetti({ count = 28 }) {
  const bits = useMemo(() => Array.from({ length: count }, (_, i) => ({
    left: Math.round((i / count) * 100 + (Math.random() * 6 - 3)),
    w: 6 + Math.round(Math.random() * 6),
    h: 9 + Math.round(Math.random() * 8),
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    dx: `${Math.round(Math.random() * 160 - 80)}px`,
    rot: `${Math.round(Math.random() * 900 - 360)}deg`,
    dur: `${(2.2 + Math.random() * 1.7).toFixed(2)}s`,
    delay: `${(Math.random() * 0.5).toFixed(2)}s`,
  })), [count]);
  return (
    <div className="togo-confetti absolute inset-0 pointer-events-none" aria-hidden>
      {bits.map((b, i) => (
        <i key={i} style={{
          left: `${b.left}%`, width: b.w, height: b.h, background: b.color,
          '--dx': b.dx, '--rot': b.rot, '--dur': b.dur, '--delay': b.delay,
        }} />
      ))}
    </div>
  );
}
