import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Hash, AlertCircle, Plus, Loader2, MessageCircle, ExternalLink } from 'lucide-react';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
// Derivations, the rate state, and predicates all come from the quote Model.
import {
  computeTotals, computeTotalsRange, lineForTotals, isPricedLine,
  effectiveRates, quoteRateState, applyAction, reanchorMaterial,
} from '../core/quote/index.js';
import { groupFamilies, productForGrade, splitSkuGrade, materiallessRangePatch } from '../lib/catalog.js';
import { resolveQuoteInvoiceStatus } from '../core/bridge/index.js';
import { parseOrderRefs } from '../core/crm/index.js';
import { composeSubtype } from '../lib/subtype.js';
import { LINE_KIND_ITEM } from '../lib/constants.js';
import { useKeyboardShortcut } from '../lib/useKeyboardShortcut.js';
import { DebouncedTextarea } from '../components/DebouncedInput.jsx';

import QuoteHeader from '../components/quote-builder/QuoteHeader.jsx';
import QuoteStatusStepper from '../components/quote-builder/QuoteStatusStepper.jsx';
import LineItemList from '../components/quote-builder/LineItemList.jsx';
import { FamiliesContext } from '../components/quote-builder/FamiliesContext.js';
import { MaterialsContext } from '../components/quote-builder/MaterialsContext.js';
import { ProjectPaletteContext } from '../components/quote-builder/ProjectPaletteContext.js';
import ProjectPaletteCard from '../components/quote-builder/ProjectPaletteCard.jsx';
import { QuoteActionsContext, useQuoteActions } from '../components/quote-builder/QuoteActionsContext.js';
import { rememberSwatchInCatalog } from '../lib/swatchCatalog.js';
import { displayPhone, waDigits } from '../lib/phone.js';
import { shareLinkUrl, newShareToken } from '../lib/quoteShare.js';
import { quoteSlug } from '../lib/quoteNaming.js';
import TotalsDock from '../components/quote-builder/TotalsDock.jsx';
import ModeBar from '../components/quote-builder/ModeBar.jsx';
import { SendQuoteModal } from '../components/quote-builder/WhatsAppChip.jsx';
import ContactChatCard from '../components/whatsapp/ContactChatCard.jsx';
import ShipmentTracking from '../components/ShipmentTracking.jsx';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import PrintPdfModal from '../components/PrintPdfModal.jsx';
import CatalogPicker from '../components/quote-builder/CatalogPicker.jsx';
import InventoryPicker from '../components/quote-builder/InventoryPicker.jsx';
import AddSourceButtons from '../components/quote-builder/AddSourceButtons.jsx';
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

// Nearest scrollable ancestor of a node — the app-shell <main> for anything
// rendered inside a page. Used to snapshot/restore the page scroll position
// across the workspace's mode switches so the dealer keeps their place.
function findScrollParent(node) {
  let el = node?.parentElement;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}

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
      // ?refs=<ref:qty,…>&customer=<id> — the "Crear cotización" action on a
      // WhatsApp catalog order seeds the draft with the client's cart.
      initialRefs={parseOrderRefs(search.get('refs') || '')}
      initialCustomerId={search.get('customer') || null}
      navigate={navigate}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Draft → Materialize                                                       */
/* -------------------------------------------------------------------------- */

function DraftWorkspace({ profileId, settings, createdByUserId, initialRef, initialRefs, initialCustomerId, navigate }) {
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

  // Pre-fill a fresh draft after materialize. Two entry points share the path:
  //   • ?ref=XXXXX            — one reference (the catalog quick-add link).
  //   • ?refs=ref:qty,…       — many references + quantities (a WhatsApp
  //     catalog order, via Chats' "Crear cotización"), with ?customer=<id>.
  // Runs ONCE (the seededRef guard) — the params don't change for a draft.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    const seeds = (initialRefs && initialRefs.length)
      ? initialRefs
      : (initialRef ? [{ reference: initialRef, qty: 1 }] : []);
    if (!seeds.length && !initialCustomerId) return;
    seededRef.current = true;
    let cancel = false;
    (async () => {
      await materialize();
      if (cancel) return;
      if (initialCustomerId) {
        try { await db.quotes.update(id, { customerId: initialCustomerId }); } catch { /* leave unassigned */ }
      }
      if (seeds.length) {
        await db.quoteLines.bulkPut(seeds.map((s, i) => ({
          id: newId(),
          quoteId: id,
          kind: LINE_KIND_ITEM,
          sortOrder: i,
          family: '',
          reference: s.reference,
          name: '',
          subtype: '',
          dimensions: '',
          description: '',
          pageRef: '',
          imageId: null,
          qty: Math.max(1, Number(s.qty) || 1),
          unitPrice: 0,
          lineMarginPct: 0,
          lineDiscountPct: 0,
          notes: '',
        })));
      }
    })();
    return () => { cancel = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Accounting → CRM through the bridge: the "Facturada · NCF" stamp for the
  // header once this quote has a sale posting in the books.
  const quotePostings = useLiveQuery(
    () => db.salesPostings.where('quoteId').equals(quoteId).toArray(),
    [quoteId],
    [],
  );
  const invoice = useMemo(
    () => resolveQuoteInvoiceStatus(quotePostings).get(quoteId) || null,
    [quotePostings, quoteId],
  );
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
    moveTargetsFor, moveLineIntoCompound, extractFromLine,
  } = useQuoteController({ quoteId, quote, lines, groups, settings, ensurePersisted });

  // Curated per-quote material library ("Paleta del proyecto") — the pinned
  // fabrics surfaced first in every material picker. `onAdd` takes the picker's
  // { grade, fabric, swatchImageId } emit, stamps an id and dedupes on
  // grade+fabric; both writes go through updateQuote (persist + autosave).
  const projectPalette = useMemo(() => {
    const lib = Array.isArray(quote?.materialLibrary) ? quote.materialLibrary : [];
    return {
      materials: lib,
      onAdd: (pick) => {
        const grade = pick?.grade || '';
        const fabric = pick?.fabric || '';
        if (!grade && !fabric) return;
        if (lib.some((m) => m.grade === grade && m.fabric === fabric)) return;
        updateQuote({ materialLibrary: [...lib, { id: newId(), grade, fabric, swatchImageId: pick?.swatchImageId ?? null }] });
      },
      // Append a whole multi-select batch in ONE write (dedupe within the batch
      // and against the current library), so adding several at once doesn't
      // clobber itself the way repeated single appends off a stale snapshot would.
      onAddMany: (picks) => {
        if (!Array.isArray(picks) || !picks.length) return;
        const next = [...lib];
        const seen = new Set(lib.map((m) => `${m.grade}\u0000${m.fabric}`));
        for (const p of picks) {
          const grade = p?.grade || '';
          const fabric = p?.fabric || '';
          if (!grade && !fabric) continue;
          const key = `${grade}\u0000${fabric}`;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({ id: newId(), grade, fabric, swatchImageId: p?.swatchImageId ?? null });
        }
        if (next.length !== lib.length) updateQuote({ materialLibrary: next });
      },
      onRemove: (id) => updateQuote({ materialLibrary: lib.filter((m) => m.id !== id) }),
    };
  }, [quote?.materialLibrary, updateQuote]);

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

  // PDF export logic lives in its own hook so the export UI (TotalsDock, the
  // banners below) stays thin.
  const {
    exporting, printing, exportError, setExportError, exportErrorRef,
    exportPdf, printPdf, generatePdf,
    printDoc, closePrint,
  } = useQuoteExport({ quote, settings, lines, customers, professionals, profiles, groups, families });

  // The ONE place the quote is sent to the client: the WhatsApp Business API
  // send modal (enlace or PDF). It is opened from the single dock action and
  // rendered once at page level — there is no OS share-sheet fallback, so the
  // send never bypasses the dealer's WhatsApp number.
  const [sendOpen, setSendOpen] = useState(false);

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
  const [view, setView] = useState('compose'); // 'compose' | 'client' | 'chat'
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);

  // Mode switching must not lose the dealer's place in a long quote. The three
  // surfaces (compose / client / WhatsApp) share ONE page scroller — the app
  // shell's <main> — so when the tall compose tree unmounts for the much
  // shorter chat/client surface the browser clamps that scroller to ~0;
  // returning to compose would then snap to the top. We snapshot the compose
  // scrollTop the instant we leave it (DOM still tall, value still real) and
  // restore it in a layout effect once compose is back in the tree, before
  // paint, so the round-trip is seamless. Route EVERY view change through
  // changeView (header toggle + mobile ModeBar) so both paths preserve scroll.
  const topRef = useRef(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const composeScrollRef = useRef(0);
  const restorePendingRef = useRef(false);
  const changeView = useCallback((next) => {
    if (next === viewRef.current) return;
    const scroller = findScrollParent(topRef.current);
    if (viewRef.current === 'compose' && scroller) composeScrollRef.current = scroller.scrollTop;
    if (next === 'compose') restorePendingRef.current = true;
    setView(next);
  }, []);
  useLayoutEffect(() => {
    if (!restorePendingRef.current) return;
    restorePendingRef.current = false;
    const scroller = findScrollParent(topRef.current);
    if (scroller) scroller.scrollTop = composeScrollRef.current;
  }, [view]);

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
  useKeyboardShortcut('mod+p', () => printPdf(), { ignoreInInput: false });

  if (!quote) {
    return (
      <div className="py-10 flex items-center justify-center gap-2 text-sm text-ink-500">
        <Loader2 size={16} className="animate-spin" aria-hidden /> Cargando…
      </div>
    );
  }

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

  // Public share link for the preview header's "Copiar enlace" button. Mints +
  // enables the share token on first use (same as sending it), then returns the
  // `/#/q/<slug>/<token>` URL — so the dealer can copy the LIVE quote link from
  // the Cliente preview and send it however they like. Editor-only (the public
  // view never gets this prop).
  const getShareLink = async () => {
    let token = quote.shareToken;
    if (!token || !quote.shareEnabled) {
      token = token || newShareToken();
      await updateQuote({ shareToken: token, shareEnabled: true });
    }
    return shareLinkUrl(token, quoteSlug(quote, customer));
  };

  return (
    <>
      {/* Scroll-position anchor — its scroll parent is the app-shell <main>,
          which changeView snapshots/restores across mode switches. */}
      <div ref={topRef} className="hidden" aria-hidden />
      {/* The quote-editing chrome (identity, customer/seller chips, undo/redo)
          belongs to the editor only. The Cliente and WhatsApp tabs are
          stand-alone mini-apps — they get the WHOLE pane at every width — so
          the header renders in compose alone and the ModeBar (bottom bar on
          phones, floating siderail on desktop) owns navigation between the
          three surfaces. */}
      {view === 'compose' && (
        <QuoteHeader
          quote={quote}
          invoice={invoice}
          customers={customers}
          professionals={professionals}
          profileId={profileId}
          onUpdateQuote={hx(updateQuote)}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          savedAt={savedAt}
          saving={saving}
        />
      )}

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
            className="inline-flex items-center flex-shrink-0 rounded-md px-2 py-1 -my-1 -mr-1 min-h-7 coarse:min-h-11 coarse:-my-2 text-[11px] font-medium underline text-red-700 hover:text-red-900 hover:bg-red-100 active:bg-red-200 transition-colors"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Lifecycle stepper + status switching belong to the EDITOR only. The
          Cliente preview and the WhatsApp conversation are focused surfaces —
          the dealer doesn't advance the quote's status from inside them, and on
          a phone every vertical pixel there belongs to the content — so the
          stepper renders only in compose. */}
      {view === 'compose' && (
        <div className="mb-5">
          <QuoteStatusStepper quote={quote} onTransition={updateQuote} profileId={profileId} onAttachOrder={(orderId) => updateQuote({ orderId })} />
        </div>
      )}

      {view === 'chat' ? (
        <ChatPaneCard
          quote={quote}
          customer={customer}
          settings={settings}
        />
      ) : view === 'client' ? (
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
          inEditor
          getShareLink={getShareLink}
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
          <ProjectPaletteContext.Provider value={projectPalette}>
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
            onOpenInventory: () => setInventoryOpen(true),
            // Line ⇄ component moves. getMoveTargets is a pure read (no hx);
            // the two mutations are one-gesture/one-snapshot like the rest.
            getMoveTargets: moveTargetsFor,
            onMoveLineIntoCompound: hx(moveLineIntoCompound),
            onExtractFromLine: hx(extractFromLine),
            // Catalog side-effect (not an undoable line edit): remember a
            // material's swatch so the next quote that picks it is pre-filled.
            // Owns the profileId source + persistence so the editor row doesn't.
            rememberSwatch: (subtype, imageId) => {
              if (imageId && profileId) rememberSwatchInCatalog({ profileId, subtype, imageId });
            },
          }}>
            <FamiliesContext.Provider value={families}>
              <MaterialsContext.Provider value={materials}>
                <LineItemsCard
                  lines={lines}
                  groups={groups}
                  quote={quote}
                  focusLineId={focusLineId}
                />
              </MaterialsContext.Provider>
            </FamiliesContext.Provider>
          </QuoteActionsContext.Provider>
          <ProjectPaletteCard />
          </ProjectPaletteContext.Provider>
          {/* The customer's WhatsApp conversation, in the editor — read and
              answer the client being quoted without leaving the workspace.
              Sits right under the line items (above Notas) so it's in reach
              while quoting. Renders only with a customer phone + the
              Business API connected. Desktop-only: on a phone the bottom
              ModeBar's WhatsApp tab owns the conversation full-screen. */}
          <div className="hidden md:block">
            <ContactChatCard contact={customer} contactKind="customer" quoteId={quote.id} />
          </div>
          <NotesAndTermsCard quote={quote} onUpdateQuote={hx(updateQuote)} />
          {/* Shipment tracking — renders only when this quote's order has a
              trackable container; one quote per page, so the map stays open. */}
          {quote.orderId && <ShipmentTracking orderId={quote.orderId} />}
        </div>
      )}

      {/* Bottom clearance for the fixed chrome. The app shell (Layout
          MainContent) already pads the page bottom by the home-indicator safe
          area + 1.5rem, so this only adds the remaining height — NOT another
          safe-area inset. (Re-adding it double-counted the home indicator,
          leaving a dead gap under the bar.) Under md the ModeBar (3.5rem)
          stacks beneath the dock, so the clearance grows to dock + bar; in
          chat mode the dock is hidden and the chat pane already sizes itself to
          end exactly at the ModeBar, so no extra clearance is needed there. */}
      <div className={view === 'chat' ? 'h-0' : 'h-[6.5rem] md:h-12'} aria-hidden />

      {/* Persistent totals dock — pinned above the ModeBar on phones, at the
          screen bottom from md: up. Hidden in chat mode: the conversation's
          composer owns the bottom edge there, and a money bar over a chat
          would just crowd the keyboard. */}
      {view !== 'chat' && (
        <TotalsDock
          quote={quote}
          rateLocked={rateState.locked}
          totals={totals}
          totalsRange={totalsRange}
          professional={professional}
          onUpdateQuote={hx(updateQuote)}
          onExport={exportPdf}
          exporting={exporting}
          onPrint={printPdf}
          printing={printing}
          onShare={() => setSendOpen(true)}
        />
      )}

      {/* Mobile mode switcher — compose / client preview / WhatsApp chat. */}
      <ModeBar view={view} onChange={changeView} customer={customer} />

      <CatalogPicker
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onInsert={hx((seed) => addLine(seed))}
      />

      <InventoryPicker
        open={inventoryOpen}
        onClose={() => setInventoryOpen(false)}
        onInsert={hx((seed) => addLine(seed))}
      />

      {/* In-app print preview — rasterizes the generated PDF and prints via
          window.print() on our own page, so "Imprimir" can never download. */}
      {printDoc && (
        <PrintPdfModal
          blob={printDoc.blob}
          title="Imprimir cotización"
          onClose={closePrint}
        />
      )}

      {/* The single send surface — opened by the dock's share/send action.
          Ships the quote from the dealer's WhatsApp Business number as the
          interactive link or the exported PDF; it persists the share token
          through updateQuote and self-explains when the quote can't be sent
          yet (no customer / no number / API not connected). */}
      <SendQuoteModal
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        customer={customer}
        professional={professional}
        quote={quote}
        settings={settings}
        onUpdateQuote={hx(updateQuote)}
        buildPdf={generatePdf}
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
  const { onAddSection, onAddLine, onOpenCatalog, onOpenInventory } = useQuoteActions();
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
            <Hash size={14} /> Sección
          </button>
          {/* Quiet companion to the source buttons — adds a BLANK line to fill
              by hand (no picker), for when the dealer is typing from a paper
              price list. */}
          <button
            type="button"
            onClick={onAddLine}
            className="inline-flex items-center justify-center w-9 h-9 coarse:w-11 coarse:h-11 rounded-md text-ink-400 hover:text-ink-700 hover:bg-ink-100 active:bg-ink-200 active:scale-[0.96] transition-all"
            title="Agregar un artículo vacío para llenar a mano"
            aria-label="Agregar artículo vacío"
          >
            <Plus size={17} />
          </button>
          {/* Two separate sources, labeled: Catálogo (Ligne Roset supplier
              catalog) and Inventario (our stock on hand). */}
          <AddSourceButtons onOpenCatalog={onOpenCatalog} onOpenInventory={onOpenInventory} />
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
              <Hash size={14} /> Sección
            </button>
            <AddSourceButtons onOpenCatalog={onOpenCatalog} onOpenInventory={onOpenInventory} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The mobile WhatsApp mode — the quote customer's conversation as the page's
 * main surface (ModeBar's third tab). Reuses ContactChatCard's send wiring
 * (variant="pane") so this surface and the desktop inline card can't drift.
 * Sending the quote itself lives in ONE place — the dock's share/send action
 * (SendQuoteModal at page level) — so the pane carries only the conversation,
 * not its own send button. When a prerequisite is missing (connection,
 * customer, phone) the pane explains the next step instead of rendering dead
 * air.
 */
function ChatPaneCard({ quote, customer, settings }) {
  const connected = !!settings?.whatsappConnectedAt;
  const phone = customer?.phone || '';

  let hint = null;
  if (!connected) {
    hint = (
      <>
        WhatsApp Business no está conectado. Actívalo en{' '}
        <Link to="/settings" className="underline font-medium text-ink-700">Configuración → WhatsApp</Link>{' '}
        para chatear con el cliente desde aquí.
      </>
    );
  } else if (!customer) {
    hint = <>Asigna un cliente a la cotización en la pestaña <strong>Cotización</strong> para abrir su conversación de WhatsApp.</>;
  } else if (!phone) {
    hint = <>{customer.name || customer.company || 'El cliente'} no tiene número de WhatsApp. Agrégalo desde la pestaña <strong>Cotización</strong> (chip <strong>Agregar WhatsApp</strong>).</>;
  }

  if (hint) {
    return (
      <div className="card card-pad min-h-[16rem] flex flex-col items-center justify-center text-center gap-2.5">
        <MessageCircle size={22} className="text-emerald-600/60" aria-hidden />
        <p className="text-sm text-ink-500 max-w-sm">{hint}</p>
      </div>
    );
  }

  return (
    // A full-bleed mini-app on phones: the conversation breaks OUT of the
    // page's padding (-mx-4 cancels the shell's px-4, -mt-4 its top py-4) so the
    // thread spans the whole phone width edge-to-edge and starts right under the
    // app topbar — a native chat surface, not a card floating in a gutter. It
    // fills the viewport between the topbar above and the bottom ModeBar below:
    // the chrome to subtract is the topbar (~3.5rem, the top padding now
    // reclaimed) and the ModeBar (~3.5rem) = 7rem, plus the safe-area insets
    // that ride inside 100dvh. Bottom lands exactly on the ModeBar's top edge
    // (no dead gap, no composer hidden behind the bar); the min-h floor keeps
    // the composer usable on short landscape phones.
    // From md: up the WhatsApp tab is a first-class mode too (the floating
    // siderail reaches it). The negative margins reset and it renders as a
    // bordered panel inside the page; the same 7rem subtract (now with no
    // mobile topbar or bottom bar to clear) leaves it short of the viewport, so
    // it sits within the page padding with no scroll, and the siderail floats
    // clear of it at mid-height.
    <div className="kb-chat-pane -mx-4 -mt-4 md:mx-0 md:mt-0 bg-surface overflow-hidden flex flex-col h-[calc(var(--rs-vvh,100dvh)-7rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-[20rem] md:rounded-2xl md:border md:border-ink-200 md:shadow-soft">
      <div className="px-4 py-2 border-b border-ink-100 flex items-center justify-between gap-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <span className="text-[11px] text-ink-400 min-w-0 truncate">
          WhatsApp · {customer.name || customer.company} · {displayPhone(phone)}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {/* The same thread lives in the Chats inbox — jump there for the
              full-page surface (search, other conversations). */}
          <Link
            to={`/chats?chat=${waDigits(phone)}`}
            className="btn-ghost text-xs text-ink-500"
            title="Abrir esta conversación en la bandeja de Chats"
          >
            <ExternalLink size={12} /> Chats
          </Link>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <ContactChatCard contact={customer} contactKind="customer" quoteId={quote.id} variant="pane" />
      </div>
    </div>
  );
}

function NotesAndTermsCard({ quote, onUpdateQuote }) {
  return (
    <div className="card card-pad space-y-4">
      <h2 className="font-display font-semibold text-sm">Notas y términos</h2>
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
