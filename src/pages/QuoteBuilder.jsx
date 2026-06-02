import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Hash, AlertCircle, PackageSearch, Share2, Plus } from 'lucide-react';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
// Derivations, the rate state, and predicates all come from the quote Model.
import {
  computeTotals, computeTotalsRange, lineForTotals, isPricedLine,
  effectiveRates, quoteRateState, applyAction, reanchorMaterial,
} from '../core/quote/index.js';
import { groupFamilies, productForGrade, splitSkuGrade, materiallessRangePatch } from '../lib/catalog.js';
import { composeSubtype } from '../lib/subtype.js';
import { LINE_KIND_ITEM } from '../lib/constants.js';
import { useKeyboardShortcut, shortcutLabel } from '../lib/useKeyboardShortcut.js';
import { DebouncedTextarea } from '../components/DebouncedInput.jsx';

import QuoteHeader from '../components/quote-builder/QuoteHeader.jsx';
import QuoteStatusStepper from '../components/quote-builder/QuoteStatusStepper.jsx';
import LineItemList from '../components/quote-builder/LineItemList.jsx';
import { FamiliesContext } from '../components/quote-builder/FamiliesContext.js';
import { QuoteActionsContext, useQuoteActions } from '../components/quote-builder/QuoteActionsContext.js';
import { rememberSwatchInCatalog } from '../lib/swatchCatalog.js';
import TotalsDock from '../components/quote-builder/TotalsDock.jsx';
import ShipmentTracking from '../components/ShipmentTracking.jsx';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import CatalogPicker from '../components/quote-builder/CatalogPicker.jsx';
import { useQuoteController } from '../components/quote-builder/useQuoteController.js';
import { useQuoteExport } from '../components/quote-builder/useQuoteExport.js';

/**
 * The Quote Workspace — the redesigned quote builder.
 *
 * Layout is a single editable canvas with a persistent totals rail on the
 * right. The price-list PDF replaces the rail (becomes the right column)
 * when toggled — the rail collapses into a compact strip below the line
 * items so the running total stays visible.
 *
 * The "Vista cliente" toggle in the header swaps the line items area for a
 * read-only `ClientPreview` of the quote, styled like the PDF, so the dealer
 * can show the client what they're getting without downloading a file.
 *
 * Lines are still free-form (typed from the price-list PDF), and the catalog
 * picker (⌘↵) surfaces real products to insert as a starting point.
 */
export default function QuoteBuilder() {
  const navigate = useNavigate();
  const { profileId, settings, currentProfile } = useApp();
  const { quoteId: routeId } = useParams();
  const [search] = useSearchParams();

  if (routeId) return <Workspace quoteId={routeId} navigate={navigate} />;

  return (
    <DraftWorkspace
      profileId={profileId}
      settings={settings}
      // currentProfile.id is auth.uid() for the signed-in user. We stamp
      // it on every new quote so the monthly commissions report can
      // attribute the deal back to whoever closed it. Old quotes
      // without this field are skipped by the report rather than
      // credited to a random dealer.
      createdByUserId={currentProfile?.id || null}
      initialRef={search.get('ref') || ''}
      navigate={navigate}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Draft → Materialize                                                       */
/* -------------------------------------------------------------------------- */

function DraftWorkspace({ profileId, settings, createdByUserId, initialRef, navigate }) {
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = newId();
  const id = idRef.current;

  const defaults = useMemo(() => ({
    id,
    profileId,
    createdByUserId,
    number: null,
    customerId: null,
    professionalId: null,
    commissionPct: null,
    orderType: 'floor',
    orderId: null,
    status: 'draft',
    currencyCode: 'USD',
    rates: effectiveRates(settings),
    marginPct: settings?.defaultMarginPct || 0,
    discountPct: settings?.defaultDiscountPct || 0,
    shipping: 0,
    terms: settings?.quoteTerms || '',
    notes: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }), [id, profileId, settings, createdByUserId]);

  const persistedRef = useRef(false);
  const inFlightRef = useRef(null);

  const materialize = useCallback(async () => {
    if (persistedRef.current) return id;
    if (inFlightRef.current) return inFlightRef.current;
    inFlightRef.current = (async () => {
      try {
        // Derive the number from the table's current top, not a stored
        // counter — see nextSequenceNumber's docstring for why. The
        // assign-helper handles the read+write race under multi-user
        // load: if another browser took our number, it retries
        // against the new max instead of failing.
        await assignSequenceNumber({
          table: 'quotes',
          profileId,
          start: 1001,
          build: (number) => ({ ...defaults, number, updatedAt: Date.now() }),
        });
        persistedRef.current = true;
        try { window.history.replaceState(null, '', `#/quotes/${id}`); } catch {}
        return id;
      } catch (e) {
        inFlightRef.current = null;
        throw e;
      }
    })();
    return inFlightRef.current;
  }, [id, defaults, profileId]);

  // ?ref=XXXXX pre-fills the first line's reference field after materialize.
  useEffect(() => {
    if (!initialRef) return;
    let cancel = false;
    (async () => {
      await materialize();
      if (cancel) return;
      await db.quoteLines.put({
        id: newId(),
        quoteId: id,
        kind: LINE_KIND_ITEM,
        sortOrder: 0,
        family: '',
        reference: initialRef,
        name: '',
        subtype: '',
        dimensions: '',
        description: '',
        pageRef: '',
        imageId: null,
        qty: 1,
        unitPrice: 0,
        lineMarginPct: 0,
        lineDiscountPct: 0,
        notes: '',
      });
    })();
    return () => { cancel = true; };
  }, [initialRef]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Workspace
      quoteId={id}
      navigate={navigate}
      draftQuote={defaults}
      materialize={materialize}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Workspace                                                                  */
/* -------------------------------------------------------------------------- */

function Workspace({ quoteId, navigate, draftQuote, materialize }) {
  const { settings, profileId, profiles } = useApp();
  const dbQuote = useLiveQuery(() => db.quotes.get(quoteId), [quoteId], null);
  const baseQuote = dbQuote || draftQuote || null;
  // Resolve the exchange rate the editor (and everything it feeds —
  // totals rail, line items, client preview, PDF export) renders with.
  // Until a quote is ACCEPTED it tracks the live published rate from
  // Settings, so the dealer (and the client on the link) always sees
  // today's number. Once the quote is ACCEPTED the rate is locked to the
  // snapshot taken at accept time. The lock + the rate map come from ONE
  // place — quoteRateState — so the totals-dock padlock and the priced figure
  // can never disagree; we resolve it once here and pass both down.
  const rateState = useMemo(() => quoteRateState(baseQuote, settings), [baseQuote, settings]);
  const quote = useMemo(() => {
    if (!baseQuote) return null;
    return { ...baseQuote, rates: rateState.rates };
  }, [baseQuote, rateState]);
  const lines = useLiveQuery(
    () => db.quoteLines.where('quoteId').equals(quoteId).sortBy('sortOrder'),
    [quoteId],
    [],
  );
  // Per-group attributes (is_optional) for Conjuntos / Alternativas, keyed by
  // the same id the lines carry in setGroup / alternativeGroup.
  const groups = useLiveQuery(
    () => db.quoteGroups.where('quoteId').equals(quoteId).toArray(),
    [quoteId],
    [],
  );
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const professionals = useLiveQuery(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  // Catalog products → families, keyed by SKU root. Feeds the material-options
  // delta math (QuoteLineItem resolves a line's family from its reference) and
  // the client preview's preview-side deltas (passed down as `families`). The
  // product table is small enough to hold in memory; grouping is memoised.
  const products = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId],
    [],
  );
  const families = useMemo(() => {
    const map = new Map();
    for (const fam of groupFamilies(products)) map.set(fam.root, fam);
    return map;
  }, [products]);

  // The fabric catalog + per-model offered-fabric allowlists, so the in-app
  // "Vista cliente" preview drives the SAME full picker the public link does
  // (the dealer can configure fabrics from the client view too).
  const materials = useLiveQuery(
    () => (profileId ? db.materials.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId],
    [],
  );
  const modelFabricRows = useLiveQuery(
    () => (profileId ? db.modelFabrics.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId],
    [],
  );
  const modelFabrics = useMemo(() => {
    const out = {};
    for (const r of modelFabricRows || []) if (r?.id && r.patternNames?.length) out[r.id] = r.patternNames;
    return out;
  }, [modelFabricRows]);

  const ensurePersisted = useCallback(async () => {
    if (materialize) await materialize();
  }, [materialize]);

  // The editor's logic core — every quote/line mutation, the undo/redo
  // history machine, and the save indicator — lives in useQuoteController so
  // this component is mostly UI + wiring. Destructured into the same local
  // names the JSX and the QuoteActionsContext below already use, so only the
  // SOURCE of these handlers moved, not their call sites.
  const {
    saving, savedAt, focusLineId,
    canUndo, canRedo, undo, redo, hx, undoToast,
    updateQuote, addLine, addSection, updateLine, duplicateLine,
    toggleOptional, addAlternative, selectAlternative, separateFromSet,
    toggleGroupOptional, joinSet, ungroupLine, removeLine, reorderLines,
  } = useQuoteController({ quoteId, quote, lines, groups, settings, ensurePersisted });

  // Editor-side full fabric picker (the "Vista cliente" preview drives it too).
  // Derive a model's per-grade catalog price for a line — feeds the picker's
  // price column + in-grade list — and commit a chosen fabric back to the real
  // quote line, repricing by grade exactly like the public link, through
  // updateLine so it joins undo/redo + autosave.
  // `marginFactor` bakes the line's margin (quote × line) into the per-grade
  // price, mirroring the public link's gradePricesFor (the bundle bakes the same
  // factor) — so the fabric picker shows the SAME numbers on both surfaces. The
  // caller (ClientPreview) supplies the per-line factor; default 1 = raw list.
  const editorGradePricesFor = useCallback((reference, marginFactor = 1) => {
    const root = splitSkuGrade(reference || '').root;
    const fam = root ? families.get(root) : null;
    if (!fam || !fam.graded) return null;
    const out = {};
    for (const g of fam.grades) { const p = fam.byGrade.get(g); if (p?.priceUsd != null) out[g] = (Number(p.priceUsd) || 0) * marginFactor; }
    return Object.keys(out).length ? out : null;
  }, [families]);

  const editorMaterialPatch = useCallback((entity, sel, grade) => {
    const root = splitSkuGrade(entity.reference || '').root;
    const fam = root ? families.get(root) : null;
    const p = fam ? productForGrade(fam, grade) : null;
    if (!p || p.priceUsd == null) return null; // grade has no catalog SKU → reject
    const fabric = String(sel?.fabric ?? '').slice(0, 200);
    const patch = {
      reference: root ? root + grade.toUpperCase() : entity.reference,
      subtype: composeSubtype(grade, fabric),
      swatchImageId: sel?.swatchImageId == null ? null : sel.swatchImageId,
      unitPrice: Number(p.priceUsd) || 0,
      unitCost: p.cost == null ? null : Number(p.cost),
      priceMin: null,
      priceMax: null,
    };
    const mo = entity.materialOptions;
    if (mo && Array.isArray(mo.options) && mo.options.length) {
      patch.materialOptions = { ...mo, baseGrade: grade.toUpperCase(), baseLabel: fabric };
    }
    return patch;
  }, [families]);

  // Clearing the chosen fabric (the swatch's red ×) — return the line/component
  // to its material-less RANGE, the same shape CatalogPicker.insertRange adds it
  // in (cheapest→priciest grade price). The editor's own path to the rule
  // applyAction/quote-share encode for the client link; a no-op when the model
  // can't span a range. The reference is left as-is (still root-resolvable).
  const editorClearPatch = useCallback((entity) => {
    const root = splitSkuGrade(entity.reference || '').root;
    return materiallessRangePatch(root ? families.get(root) : null);
  }, [families]);

  const pickMaterialInEditor = useCallback((id, sel) => {
    // An empty grade is a CLEAR (the swatch ×) → revert to the range; otherwise
    // it's a fabric pick → reprice to that grade.
    const grade = String(sel?.grade ?? '').trim();
    const line = lines.find((l) => l.id === id);
    if (line) {
      const patch = grade ? editorMaterialPatch(line, sel, grade) : editorClearPatch(line);
      if (patch) updateLine(id, patch);
      return;
    }
    for (const l of lines) {
      const comps = l.components;
      if (!Array.isArray(comps)) continue;
      const idx = comps.findIndex((c) => c.id === id);
      if (idx < 0) continue;
      const patch = grade ? editorMaterialPatch(comps[idx], sel, grade) : editorClearPatch(comps[idx]);
      if (patch) {
        const newComps = comps.slice();
        newComps[idx] = { ...comps[idx], ...patch };
        updateLine(l.id, { components: newComps });
      }
      break;
    }
  }, [lines, editorMaterialPatch, editorClearPatch, updateLine]);

  // Apply-to-all twin: dress many components (a materialPick map of id → sel) in
  // one pass, batching every target that shares a line into a single updateLine
  // so a compound's pieces re-price together as one undo step. Mirrors
  // pickMaterialInEditor's per-piece repricing (editorMaterialPatch).
  const pickMaterialManyInEditor = useCallback((selsById) => {
    const selById = new Map(Object.entries(selsById || {}));
    if (!selById.size) return;
    for (const l of lines) {
      const comps = l.components;
      if (!Array.isArray(comps)) continue;
      let touched = false;
      const newComps = comps.map((c) => {
        const sel = selById.get(c.id);
        if (!sel) return c;
        // An empty grade is a CLEAR (the zone / whole-piece × routes through
        // onPickMany) → revert to the range; otherwise reprice to the picked
        // grade. Mirrors pickMaterialInEditor's single-target branch; without the
        // clear arm a grouped/uniform compound's × was a silent no-op.
        const grade = String(sel?.grade ?? '').trim();
        const patch = grade ? editorMaterialPatch(c, sel, grade) : editorClearPatch(c);
        if (!patch) return c;
        touched = true;
        return { ...c, ...patch };
      });
      if (touched) updateLine(l.id, { components: newComps });
    }
  }, [lines, editorMaterialPatch, editorClearPatch, updateLine]);

  // -- "Vista cliente" interactive picks: the SAME four the public link wires --
  // The preview pane lets the dealer configure the quote exactly as the client
  // would on the share link. Optionals + alternatives are pure flag flips (no
  // repricing), so we replay them through the link's OWN optimistic reducer
  // (applyAction) over the live lines and persist whatever it touched via
  // updateLine — guaranteeing the preview applies a pick byte-for-byte like the
  // link. A line-level flip writes one field; a component-level flip writes the
  // line's components array.
  const applyEditorPick = useCallback((pick) => {
    const next = applyAction({ lines }, pick).lines;
    if (next === lines) return;            // invalid / no-op pick → nothing to write
    for (let i = 0; i < lines.length; i++) {
      if (next[i] === lines[i]) continue;
      const patch = {};
      if (next[i].isOptional !== lines[i].isOptional) patch.isOptional = next[i].isOptional;
      if (next[i].isSelectedAlternative !== lines[i].isSelectedAlternative) patch.isSelectedAlternative = next[i].isSelectedAlternative;
      if (next[i].components !== lines[i].components) patch.components = next[i].components;
      if (Object.keys(patch).length) updateLine(lines[i].id, patch);
    }
  }, [lines, updateLine]);

  // Grade-chip pick (the link's `materials` action / server lineMaterialPatch):
  // re-anchor the offered grades so the picked one becomes the base (the Model's
  // parity-tested reanchor — old base demoted into the options, swatch + subtype
  // recomposed) and reprice from the catalog in RAW USD; resolveQuoteView applies
  // the margin downstream exactly as the bundle bakes it server-side. Distinct from
  // the FULL picker (editorMaterialPatch / onPickMaterial), which sets an ARBITRARY
  // fabric and only re-bases baseGrade/baseLabel. Returns null when the grade isn't
  // offered (mirrors the server's reject).
  const editorGradeReanchorPatch = useCallback((entity, grade) => {
    const g = String(grade ?? '').trim();
    if (!g) return null;
    const r = reanchorMaterial(entity.materialOptions, g, entity.swatchImageId);
    if (!r) return null;
    const root = splitSkuGrade(entity.reference || '').root;
    const fam = root ? families.get(root) : null;
    const p = fam ? productForGrade(fam, g) : null;
    const patch = {
      materialOptions: r.newMo,
      swatchImageId: r.newSwatchId,
      subtype: composeSubtype(g, r.label),
      priceMin: null,
      priceMax: null,
    };
    if (root) patch.reference = root + g.toUpperCase();
    if (p && p.priceUsd != null) { patch.unitPrice = Number(p.priceUsd) || 0; patch.unitCost = p.cost == null ? null : Number(p.cost); }
    return patch;
  }, [families]);

  const selectMaterialInEditor = useCallback((id, grade) => {
    const line = lines.find((l) => l.id === id);
    if (line) {
      const patch = editorGradeReanchorPatch(line, grade);
      if (patch) updateLine(id, patch);
      return;
    }
    for (const l of lines) {
      const comps = l.components;
      if (!Array.isArray(comps)) continue;
      const idx = comps.findIndex((c) => c.id === id);
      if (idx < 0) continue;
      const patch = editorGradeReanchorPatch(comps[idx], grade);
      if (patch) {
        const newComps = comps.slice();
        newComps[idx] = { ...comps[idx], ...patch };
        updateLine(l.id, { components: newComps });
      }
      break;
    }
  }, [lines, editorGradeReanchorPatch, updateLine]);

  // PDF export + share-link logic lives in its own hook so the export UI
  // (TotalsDock, the banners below) stays thin. It persists the share token
  // through updateQuote — the single quote writer from the controller above.
  const {
    exporting, exportError, setExportError,
    sharing, shareMsg, setShareMsg, exportErrorRef,
    exportPdf, shareQuote,
  } = useQuoteExport({ quote, settings, lines, customers, professionals, profiles, groups, families, updateQuote });

  // Heal legacy quotes that lost their sequence number to the old
  // updateQuote write-back race (it persisted the stale in-memory quote,
  // number:null, right after materialize had assigned one). Assign the
  // next number in place the first time such a quote is opened; race-safe
  // so two tabs don't double-assign. New drafts can't reach here — they
  // get their number at materialize and updateQuote now preserves it.
  useEffect(() => {
    if (!dbQuote || dbQuote.number != null || !profileId) return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await db.quotes.get(quoteId);
        if (cancelled || !fresh || fresh.number != null) return;
        await assignSequenceNumber({
          table: 'quotes',
          profileId,
          start: 1001,
          build: (number) => ({ ...fresh, number, updatedAt: Date.now() }),
        });
      } catch (e) {
        console.warn('[QuoteBuilder] could not heal missing quote number:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [dbQuote, quoteId, profileId]);

  // -------- view + panel state --------
  // The "lista de precios" PDF panel (a `pdfjs-dist` viewer that slid
  // in from the right with the LR price list) was removed entirely —
  // including the upload affordance in Settings, the panel toggle in
  // the header, and the pdfjs-dist dependency itself. The quote
  // builder now stays focused on quote construction; price-list lookup
  // happens outside the app.
  const [view, setView] = useState('compose'); // 'compose' | 'client'
  const [catalogOpen, setCatalogOpen] = useState(false);

  /* ---------------------------- shortcuts ----------------------------
   * Kept deliberately small to avoid clashing with the browser:
   *   ⌘↵       — open the catalog to add a product (works even inside an input)
   *   ⌘P       — export PDF (commandeers the browser's print shortcut on
   *              purpose — the PDF IS the print equivalent for this app)
   * The client-view toggle is intentionally NOT bound — every browser has
   * its own ⌘E meaning, and the header toggle covers the need.
   *
   * These hooks live above the `!quote` guard so the hook count stays
   * stable between the initial "loading" render and the post-load render.
   * The handlers are hoisted function declarations, so referencing them
   * before their lexical position is fine; they're only invoked on user
   * keypress, by which point `quote` is populated.
   */
  useKeyboardShortcut('mod+enter', () => setCatalogOpen(true), { ignoreInInput: false });
  useKeyboardShortcut('mod+p', () => exportPdf(), { ignoreInInput: false });

  if (!quote) return <div className="text-sm text-ink-500">Cargando…</div>;

  const totalsQuote = { marginPct: quote.marginPct, discountPct: quote.discountPct, courtesyDiscountPct: quote.courtesyDiscountPct, shipping: quote.shipping };
  const totals = computeTotals(lines.filter(isPricedLine).map(lineForTotals), totalsQuote);
  // Range twin of the grand total — widens to "min … max" while any priced
  // line is quoted by range (material-less). Collapses to a point (and the UI
  // falls back to the single figure) once every line carries a real price.
  const totalsRange = computeTotalsRange(lines, totalsQuote);

  /* ---------------------------- render ---------------------------- */

  const customer = quote.customerId ? customers.find((c) => c.id === quote.customerId) : null;
  const professional = quote.professionalId ? professionals.find((p) => p.id === quote.professionalId) : null;
  const seller = quote.createdByUserId ? (profiles || []).find((p) => p.id === quote.createdByUserId) : null;

  return (
    <>
      <QuoteHeader
        quote={quote}
        customers={customers}
        professionals={professionals}
        profileId={profileId}
        view={view}
        onViewChange={setView}
        onUpdateQuote={hx(updateQuote)}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        savedAt={savedAt}
        saving={saving}
      />

      {/* Surface PDF export failures inline. The export button used to
          fail silently in iOS-PWA standalone — now if anything throws
          (gesture timed out, share sheet rejected, generator crashed),
          the dealer sees a dismissible banner with the underlying
          message instead of just "I tapped it and nothing happened". */}
      {exportError && (
        <div ref={exportErrorRef} role="alert" className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">No se pudo exportar el PDF</div>
            <div className="text-red-700">{exportError}</div>
          </div>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="text-red-700 hover:text-red-900 text-[11px] underline"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Share-link toast — the copied URL (or a manual-copy fallback). */}
      {shareMsg && (
        <div role="status" className="mb-4 rounded-md bg-ink-900 text-white px-3 py-2 text-xs flex items-start gap-2">
          <Share2 size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1 break-all">{shareMsg}</div>
          <button type="button" onClick={() => setShareMsg(null)} className="text-white/70 hover:text-white text-[11px] underline">Cerrar</button>
        </div>
      )}

      <div className="mb-5">
        <QuoteStatusStepper quote={quote} onTransition={updateQuote} />
      </div>

      {view === 'client' ? (
        <ClientPreview
          quote={quote}
          settings={settings}
          lines={lines}
          quoteGroups={groups}
          totals={totals}
          totalsRange={totalsRange}
          customer={customer}
          professional={professional}
          seller={seller}
          families={families}
          materials={materials}
          modelFabrics={modelFabrics}
          gradePricesFor={editorGradePricesFor}
          // The picks the public link wires, so the preview is live too. hx joins
          // each into undo/redo + autosave (one snapshot per gesture), matching the
          // editor's other actions (QuoteActionsContext). onPickMaterialMany batches
          // its updateLines, so its one snapshot still undoes the whole apply-to-all.
          onSelectMaterial={hx(selectMaterialInEditor)}
          onPickMaterial={hx(pickMaterialInEditor)}
          onPickMaterialMany={hx(pickMaterialManyInEditor)}
          onToggleOptional={hx((id, on) => applyEditorPick({ optionals: { [id]: on } }))}
          onSelectAlternative={hx((group, lineId) => applyEditorPick({ alternatives: { [group]: lineId } }))}
        />
      ) : (
        // Single full-width column: the totals live in the persistent bottom
        // dock now (not a right rail), so the line items get the full width.
        // `min-w-0` lets the column shrink below its content's intrinsic width,
        // so a long money value / dimension spec can't force a horizontal scroll.
        <div className="space-y-5 min-w-0">
          {/* Provide catalog families to every line item below (through the
              LineItemList, which doesn't thread per-line catalog props) so
              the material-options chips can show list-price deltas. */}
          {/* Editor actions flow via QuoteActionsContext instead of being
              threaded Workspace → LineItemsCard → LineItemList; catalog
              families already do the same via FamiliesContext. The item tree
              subscribes to the logic it needs, so re-nesting the UI doesn't
              re-plumb handlers. History-wrapping (hx) stays here at the source
              — note onToggleGroupOptional is intentionally NOT wrapped, as
              before. */}
          <QuoteActionsContext.Provider value={{
            onToggleGroupOptional: toggleGroupOptional,
            onChangeLine: hx(updateLine),
            onRemoveLine: hx(removeLine),
            onDuplicateLine: hx(duplicateLine),
            onToggleOptional: hx(toggleOptional),
            onAddAlternative: hx(addAlternative),
            onSelectAlternative: hx(selectAlternative),
            onSeparateFromSet: hx(separateFromSet),
            onUngroup: hx(ungroupLine),
            onJoinSet: hx(joinSet),
            onReorder: hx(reorderLines),
            onAddSection: hx(addSection),
            onAddLine: hx(() => addLine({})),
            onOpenCatalog: () => setCatalogOpen(true),
            // Catalog side-effect (not an undoable line edit): remember a
            // material's swatch so the next quote that picks it is pre-filled.
            // Owns the profileId source + persistence so the editor row doesn't.
            rememberSwatch: (subtype, imageId) => {
              if (imageId && profileId) rememberSwatchInCatalog({ profileId, subtype, imageId });
            },
          }}>
            <FamiliesContext.Provider value={families}>
              <LineItemsCard
                lines={lines}
                groups={groups}
                quote={quote}
                focusLineId={focusLineId}
              />
            </FamiliesContext.Provider>
          </QuoteActionsContext.Provider>
          <NotesAndTermsCard quote={quote} onUpdateQuote={hx(updateQuote)} />
          {/* Shipment tracking — renders only when this quote's order has a
              trackable container; one quote per page, so the map stays open. */}
          {quote.orderId && <ShipmentTracking orderId={quote.orderId} />}
        </div>
      )}

      {/* Bottom clearance for the fixed dock. The app shell (Layout MainContent)
          already pads the page bottom by the home-indicator safe area + 1.5rem,
          so this only adds the remaining dock height — NOT another safe-area
          inset. (Re-adding it double-counted the home indicator, leaving a dead
          gap under the bar.) Matches the collapsed bar: amount + DOP line. */}
      <div className="h-12" aria-hidden />

      {/* Persistent totals dock — pinned to the bottom of the screen at every
          width, replacing the old desktop right-rail and the mobile totals bar. */}
      <TotalsDock
        quote={quote}
        rateLocked={rateState.locked}
        totals={totals}
        totalsRange={totalsRange}
        professional={professional}
        onUpdateQuote={hx(updateQuote)}
        onOpenCatalog={() => setCatalogOpen(true)}
        onExport={exportPdf}
        exporting={exporting}
        onShare={shareQuote}
        sharing={sharing}
      />

      <CatalogPicker
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onInsert={hx((seed) => addLine(seed))}
      />

      {undoToast}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sub-cards                                                                  */
/* -------------------------------------------------------------------------- */

function LineItemsCard({ lines, groups, quote, focusLineId }) {
  // The header/footer add buttons use just these two; LineItemList subscribes
  // to the rest of the editor actions from context itself.
  const { onAddSection, onAddLine, onOpenCatalog } = useQuoteActions();
  return (
    <div className="card overflow-hidden">
      <header className="card-header">
        <h2>Artículos</h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAddSection}
            className="btn-ghost text-xs hidden sm:inline-flex"
            title="Agregar sección"
          >
            <Hash size={12} /> Sección
          </button>
          {/* Quiet companion to the catalog CTA — adds a BLANK line to fill by
              hand (no picker), for when the dealer is typing from a paper price
              list. Small, gray icon so the Inventario button stays the headline. */}
          <button
            type="button"
            onClick={onAddLine}
            className="inline-flex items-center justify-center w-9 h-9 coarse:w-10 coarse:h-10 rounded-md text-ink-400 hover:text-ink-700 hover:bg-ink-100 active:bg-ink-200 transition-colors"
            title="Agregar un artículo vacío para llenar a mano"
            aria-label="Agregar artículo vacío"
          >
            <Plus size={18} />
          </button>
          {/* The catalog fills a line from a real product (ref, name, price,
              cost, grade/fabric); the blank button beside it is the manual path. */}
          <button
            type="button"
            onClick={onOpenCatalog}
            className="btn-primary transition-all hover:shadow-md"
            title={`Elegir un producto del inventario (${shortcutLabel('mod+enter')})`}
          >
            <PackageSearch size={18} /> Inventario
          </button>
        </div>
      </header>
      <LineItemList
        lines={lines}
        groups={groups}
        quote={quote}
        focusLineId={focusLineId}
      />
      {lines.length > 0 && (
        <div className="px-5 py-3 border-t border-ink-100 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-500">
            {lines.filter(isPricedLine).length} artículo(s) · arrastra
            <span className="font-mono"> ⋮⋮ </span>para reordenar
          </span>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={onAddSection} className="btn-ghost text-xs">
              <Hash size={12} /> Sección
            </button>
            <button type="button" onClick={onOpenCatalog} className="btn-secondary text-xs">
              <PackageSearch size={16} /> Inventario
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NotesAndTermsCard({ quote, onUpdateQuote }) {
  return (
    <div className="card card-pad space-y-4">
      <h2 className="font-semibold text-sm">Notas y términos</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label flex items-center justify-between">
            <span>Notas internas</span>
            <span className="text-[9px] text-ink-400 normal-case tracking-normal">solo equipo</span>
          </div>
          <DebouncedTextarea
            className="input min-h-[100px]"
            value={quote.notes || ''}
            onCommit={(v) => onUpdateQuote({ notes: v })}
            placeholder="Información que solo ve tu equipo."
          />
        </div>
        <div>
          <div className="label flex items-center justify-between">
            <span>Términos</span>
            <span className="text-[9px] text-ink-400 normal-case tracking-normal">se imprimen en el PDF</span>
          </div>
          <DebouncedTextarea
            className="input min-h-[100px]"
            value={quote.terms || ''}
            onCommit={(v) => onUpdateQuote({ terms: v })}
            placeholder="Validez, plazos de entrega, condiciones de pago…"
          />
        </div>
      </div>
    </div>
  );
}
