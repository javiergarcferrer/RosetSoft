import { useEffect, useRef, useState } from 'react';
import { db, newId } from '../../db/database.js';
import { LINE_KIND_ITEM, LINE_KIND_SECTION } from '../../lib/constants.js';
import { effectiveRates } from '../../lib/exchangeRate.js';
import {
  isGroupOptional, selectAlternativePatches, healAlternativeOnRemove, healSetOnRemove,
} from '../../lib/quoteGroups.js';
import { isModularLine, absorbLineAsComponents, extractComponentsAsLine } from '../../lib/modules.js';
import { boundedPush, diffLinesForRestore } from '../../lib/quoteHistory.js';
import { reconcileQuoteStock } from '../../lib/lsgStock.js';
import { useUndoToast } from './UndoToast.jsx';

// How many edit steps the workspace remembers for undo/redo. Each step is a
// whole-quote snapshot (the quote row + all its lines); 50 covers a long
// editing session without unbounded memory growth.
const HISTORY_LIMIT = 50;

/**
 * The quote editor's logic core, lifted out of the `Workspace` component so
 * the page is mostly UI + wiring (the actions reach the item tree via
 * `QuoteActionsContext`). Owns:
 *   - the ~14 quote/line mutations, each writing straight to the DB;
 *   - the undo/redo history machine (whole-quote snapshots in refs) plus its
 *     ⌘Z/⌘Y keyboard binding and per-quote reset;
 *   - the save-status indicator and the "focus the newest line" signal.
 *
 * Mutations are plain (non-memoised) closures recreated each render — exactly
 * as when they lived in the component — so they close over the fresh
 * `quote`/`lines`/`groups` passed in, with no stale-snapshot surprises. The
 * single quote writer is `updateQuote`; `ensurePersisted` (a brand-new draft
 * may need materialising first) and the live `settings` are injected.
 */
export function useQuoteController({ quoteId, quote, lines, groups, settings, ensurePersisted }) {
  // -------- save indicator state --------
  // We track a UI-only timestamp here rather than reading quote.updatedAt
  // because line edits don't bump the parent quote's updatedAt (by design).
  const [savedAt, setSavedAt] = useState(quote?.updatedAt || null);
  const [saving, setSaving] = useState(false);
  // Counter of in-flight writes so concurrent edits don't flicker the badge.
  const inFlight = useRef(0);

  function markSaving() { inFlight.current += 1; setSaving(true); }
  function markSaved() {
    inFlight.current = Math.max(0, inFlight.current - 1);
    if (inFlight.current === 0) {
      setSaving(false);
      setSavedAt(Date.now());
    }
  }

  // -------- focus for the newest line --------
  const [focusLineId, setFocusLineId] = useState(null);

  // -------- undo toast --------
  // One toast surface, two semantic channels: `showUndo(msg, undoFn)` for the
  // delete → "Deshacer" affordance, and `showStockError(msg)` for a NON-undoable
  // Shopify stock-sync failure (a plain message + close button — never an undo
  // button, since there's nothing to undo). Sharing the element keeps the single
  // toast slot the page renders; the named wrapper keeps the intent honest.
  const { show: showUndo, element: undoToast } = useUndoToast();
  const showStockError = (msg) => showUndo(msg);

  /* ---------------------------- undo / redo --------------------------
   * The builder writes every edit straight to the DB, so undo is a stack
   * of whole-quote snapshots ({ quote, lines }). We push the PRE-edit
   * snapshot before each user action (see `hx` below), and undo restores
   * the previous one. Stacks live in refs (no stale-closure surprises);
   * a version counter forces the toolbar buttons to re-evaluate
   * canUndo/canRedo. Reset whenever we switch quotes.
   *
   * The imperative helpers (snapshotNow/applySnapshot/undo/redo/hx) are
   * hoisted function declarations defined below the effects that list them. */
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  // The stacks live in refs (authoritative, no stale-closure surprises) but the
  // toolbar's enabled/disabled state is driven by STATE — the stack DEPTHS,
  // mirrored from the refs after every change via `syncHistory()`. Reading
  // ref.current.length during render would be fragile (a mutable read in render);
  // these depths re-render the buttons deterministically instead.
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  function syncHistory() {
    setUndoDepth(undoRef.current.length);
    setRedoDepth(redoRef.current.length);
  }

  useEffect(() => {
    undoRef.current = [];
    redoRef.current = [];
    syncHistory();
  }, [quoteId]);

  useEffect(() => {
    function onKey(e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      // Let the browser's native text undo win while the caret is in a
      // field — otherwise Cmd+Z mid-typing would revert the whole quote.
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // undo/redo are hoisted function declarations recreated each render but only
    // touch refs + state setters (stable), so binding once on mount is correct
    // and avoids re-subscribing the global listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep copy of the current quote + lines — the unit of undo. structuredClone
  // is safe here: rows are plain JSON-ish objects (numbers, strings, nested
  // `components` arrays), no functions or DOM nodes.
  function snapshotNow() {
    return { quote: structuredClone(quote), lines: structuredClone(lines) };
  }

  function pushUndo(snap) {
    undoRef.current = boundedPush(undoRef.current, snap, HISTORY_LIMIT);
    redoRef.current = [];   // a fresh edit invalidates the redo branch
    syncHistory();
  }

  // Write a snapshot back to the DB, making the quote + its lines match it
  // exactly. Preserves the live sequence number the same way updateQuote
  // does, so an undo can never clobber a freshly assigned `number`.
  async function applySnapshot(snap) {
    markSaving();
    try {
      const persisted = await db.quotes.get(quoteId);
      await db.quotes.put({
        ...snap.quote,
        number: persisted?.number ?? snap.quote.number,
        updatedAt: Date.now(),
      });
      const current = await db.quoteLines.where('quoteId').equals(quoteId).toArray();
      const { toDelete, toPut } = diffLinesForRestore(current, snap.lines);
      for (const id of toDelete) await db.quoteLines.delete(id);
      for (const l of toPut) await db.quoteLines.put(l);
      // Undo/redo can restore a different accept/order state — re-reconcile LSG
      // Shopify stock to the restored snapshot. The committed ledger lives in
      // its own table (untouched by the snapshot), so this restocks/deducts the
      // exact difference and never rewinds the reservation. Surface a failure the
      // same way updateQuote does — a missed restock on undo must not be silent.
      // 'not-connected' is expected when LSG isn't linked → quiet.
      reconcileQuoteStock(quoteId)
        .then((r) => {
          if (r?.status === 'error') {
            showStockError(`No se pudo actualizar el stock en Shopify: ${(r.errors || []).join(' · ') || 'inténtalo de nuevo.'}`);
          }
        })
        .catch(() => {});
    } finally {
      markSaved();
    }
  }

  async function undo() {
    if (!undoRef.current.length) return;
    const prev = undoRef.current[undoRef.current.length - 1];
    undoRef.current = undoRef.current.slice(0, -1);
    redoRef.current = boundedPush(redoRef.current, snapshotNow(), HISTORY_LIMIT);
    syncHistory();
    await applySnapshot(prev);
  }

  async function redo() {
    if (!redoRef.current.length) return;
    const next = redoRef.current[redoRef.current.length - 1];
    redoRef.current = redoRef.current.slice(0, -1);
    undoRef.current = boundedPush(undoRef.current, snapshotNow(), HISTORY_LIMIT);
    syncHistory();
    await applySnapshot(next);
  }

  // Wrap a mutation so it records a pre-edit snapshot first. One snapshot
  // per user gesture: handlers that delegate (e.g. ungroupLine →
  // separateFromSet) call the RAW inner function, never another wrapped
  // one, so a single action is a single undo step.
  function hx(fn) {
    return (...args) => {
      pushUndo(snapshotNow());
      return fn(...args);
    };
  }

  const canUndo = undoDepth > 0;
  const canRedo = redoDepth > 0;

  /* ---------------------------- mutations ---------------------------- */

  async function updateQuote(patch) {
    markSaving();
    try {
      await ensurePersisted();
      // Lock the exchange rate the instant the quote is ACCEPTED: freeze the
      // current live rate onto the quote so later Settings changes can't move a
      // figure the client committed to. Until then (draft / sent) the rate stays
      // live, so a quote the client is still deciding on tracks today's bank
      // rate. `patch.acceptedAt` is set only on a real accept (the stepper's
      // advance), not on an undo back to 'accepted' — so re-accepting after an
      // undo re-locks at the then-current rate, while undo preserves the snapshot.
      const next = (patch.status === 'accepted' && patch.acceptedAt)
        ? { ...patch, rates: effectiveRates(settings) }
        : patch;
      // Spread the PERSISTED row, not the stale render `quote`: ensurePersisted()
      // may have just materialized a brand-new draft (assigning its sequence
      // number), and a concurrent edit may have written other fields the live
      // query hasn't fed back yet. Re-reading and spreading {...persisted, ...next}
      // keeps the freshly assigned number AND any concurrent writes, so this patch
      // only changes the fields it actually carries.
      const persisted = await db.quotes.get(quoteId);
      await db.quotes.put({
        ...(persisted || quote),
        ...next,
        updatedAt: Date.now(),
      });
      // A status, order-attachment, or deposit change is exactly what flips
      // whether this quote's LSG pieces should be deducted from Shopify — accept
      // + order (or, for a floor sale with no order, the deposit) deducts; a
      // revert / detach / un-marked deposit restocks. The deposit is a milestone
      // patch (no status/orderId), so it must be watched explicitly or a floor
      // sale would never push. Reconcile (idempotent, best-effort) — and SURFACE
      // a Shopify failure as a toast so a missed stock update isn't silent (the
      // dealer used to get a green "Saved" regardless of whether the storefront
      // actually moved). 'not-connected' is expected when LSG isn't linked → quiet.
      if ('status' in patch || 'orderId' in patch || 'depositReceivedAt' in patch) {
        reconcileQuoteStock(quoteId)
          .then((r) => {
            if (r?.status === 'error') {
              showStockError(`No se pudo actualizar el stock en Shopify: ${(r.errors || []).join(' · ') || 'inténtalo de nuevo.'}`);
            }
          })
          .catch(() => {});
      }
    } finally {
      markSaved();
    }
  }

  function nextSortOrder() {
    return lines.length ? Math.max(...lines.map((l) => l.sortOrder || 0)) + 1 : 0;
  }

  async function addLine(seed = {}) {
    markSaving();
    try {
      await ensurePersisted();
      const id = newId();
      await db.quoteLines.put({
        id,
        quoteId,
        kind: LINE_KIND_ITEM,
        sortOrder: nextSortOrder(),
        family: seed.family || '',
        reference: seed.reference || '',
        name: seed.name || '',
        subtype: seed.subtype || '',
        dimensions: seed.dimensions || '',
        description: seed.description || '',
        productDescription: seed.productDescription || '',
        pageRef: seed.pageRef || '',
        imageId: seed.imageId || null,
        // Catalog gallery (LSG CDN pointers) seeded by the picker — the rest
        // of the store's photos beyond the cover.
        extraImageIds: Array.isArray(seed.extraImageIds) && seed.extraImageIds.length
          ? seed.extraImageIds
          : null,
        swatchImageId: seed.swatchImageId ?? null,
        qty: seed.qty ?? 1,
        unitPrice: seed.unitPrice ?? 0,
        unitCost: seed.unitCost ?? null,
        lineMarginPct: seed.lineMarginPct ?? 0,
        lineDiscountPct: seed.lineDiscountPct ?? 0,
        // Price range (material-less lines); null on a normal line.
        priceMin: seed.priceMin ?? null,
        priceMax: seed.priceMax ?? null,
        notes: seed.notes || '',
        components: Array.isArray(seed.components) ? seed.components : [],
        // Carried by extraction (a component moved out keeps being an opt-in
        // add-on and keeps its material options); both default off/empty.
        isOptional: !!seed.isOptional,
        optionalOffered: !!seed.optionalOffered,
        materialOptions: seed.materialOptions ?? null,
      });
      setFocusLineId(id);
    } finally {
      markSaved();
    }
  }

  /* ------------------- line ⇄ component moves ------------------- */

  // Compounds this line could move INTO. A simple line fits any compound; a
  // compound source only fits a MODULAR target (its pieces become a module —
  // nesting inside a plain component-product isn't representable). Lines in a
  // Conjunto/Alternativa don't move (the UI also hides the affordance): the
  // dealer separates them first, keeping group surgery explicit.
  function moveTargetsFor(sourceLine) {
    if (!sourceLine || sourceLine.kind === LINE_KIND_SECTION) return [];
    if (sourceLine.setGroup || sourceLine.alternativeGroup) return [];
    const sourceCompound = (sourceLine.components || []).length > 0;
    return lines
      .filter((l) => l.id !== sourceLine.id
        && l.kind !== LINE_KIND_SECTION
        && (l.components || []).length > 0
        && (!sourceCompound || isModularLine(l)))
      .map((l) => ({
        id: l.id,
        name: l.name || 'Compuesto',
        isModular: isModularLine(l),
        count: (l.components || []).length,
      }));
  }

  // Move a top-level line INSIDE a compound/modular: the line's content
  // becomes component rows of the target (lib/modules:absorbLineAsComponents
  // owns every gate — adjustment folding, optional mapping, id re-minting)
  // and the source row is deleted. One gesture, one undo snapshot (hx).
  async function moveLineIntoCompound(targetId, sourceLine) {
    const target = lines.find((l) => l.id === targetId);
    if (!target || !sourceLine) return;
    if (sourceLine.setGroup || sourceLine.alternativeGroup) return;
    const absorbed = absorbLineAsComponents(sourceLine, isModularLine(target), newId);
    if (!absorbed) return;
    markSaving();
    try {
      await db.quoteLines.update(targetId, {
        components: [...(target.components || []), ...absorbed],
      });
      await db.quoteLines.delete(sourceLine.id);
      setFocusLineId(targetId);
    } finally {
      markSaved();
    }
  }

  // Move a component / module OUT of a compound as its own top-level line,
  // inserted right AFTER the source compound (duplicateLine's renumber dance)
  // so the extracted product lands where the eye already is.
  async function extractFromLine(sourceLine, componentIds) {
    const res = extractComponentsAsLine(sourceLine, componentIds, newId);
    if (!res) return;
    markSaving();
    try {
      await ensurePersisted();
      const id = newId();
      const srcIdx = lines.findIndex((l) => l.id === sourceLine.id);
      const newSortOrder = (sourceLine.sortOrder ?? 0) + 1;
      const s = res.seed;
      await db.quoteLines.put({
        id,
        quoteId,
        kind: LINE_KIND_ITEM,
        sortOrder: newSortOrder,
        family: s.family || '',
        reference: s.reference || '',
        name: s.name || '',
        subtype: s.subtype || '',
        dimensions: s.dimensions || '',
        description: s.description || '',
        productDescription: s.productDescription || '',
        pageRef: '',
        imageId: null,
        swatchImageId: s.swatchImageId ?? null,
        qty: s.qty ?? 1,
        unitPrice: s.unitPrice ?? 0,
        unitCost: null,
        lineMarginPct: 0,
        lineDiscountPct: 0,
        priceMin: s.priceMin ?? null,
        priceMax: s.priceMax ?? null,
        notes: '',
        components: Array.isArray(s.components) ? s.components : [],
        isOptional: !!s.isOptional,
        optionalOffered: !!s.optionalOffered,
        materialOptions: s.materialOptions ?? null,
      });
      for (const l of lines.slice(srcIdx + 1)) {
        await db.quoteLines.update(l.id, { sortOrder: (l.sortOrder ?? 0) + 1 });
      }
      await db.quoteLines.update(sourceLine.id, { components: res.remaining });
      setFocusLineId(id);
    } finally {
      markSaved();
    }
  }

  async function addSection() {
    markSaving();
    try {
      await ensurePersisted();
      const id = newId();
      await db.quoteLines.put({
        id,
        quoteId,
        kind: LINE_KIND_SECTION,
        sortOrder: nextSortOrder(),
        family: '',
        reference: '',
        name: '',
        subtype: '',
        dimensions: '',
        description: '',
        pageRef: '',
        imageId: null,
        qty: 0,
        unitPrice: 0,
        lineMarginPct: 0,
        lineDiscountPct: 0,
        notes: '',
        components: [],
      });
      setFocusLineId(id);
    } finally {
      markSaved();
    }
  }

  async function updateLine(id, patch) {
    markSaving();
    try { await db.quoteLines.update(id, patch); }
    catch (e) { console.error('[quote] line update failed', { id, patch, error: e }); }
    finally { markSaved(); }
  }

  async function duplicateLine(line) {
    markSaving();
    try {
      await ensurePersisted();
      const id = newId();
      // Insert immediately after the source line. We renumber everything
      // after the insertion point so the new line lands exactly where the
      // user expects.
      const srcIdx = lines.findIndex((l) => l.id === line.id);
      const newSortOrder = (line.sortOrder ?? 0) + 1;
      // Deep-copy compound components and stamp fresh ids on each so
      // React keys (and any future direct-component reference) don't
      // collide between the original and the duplicate.
      const components = Array.isArray(line.components)
        ? line.components.map((c) => ({ ...c, id: newId() }))
        : [];
      await db.quoteLines.put({
        ...line,
        id,
        sortOrder: newSortOrder,
        components,
      });
      // Bump everyone after.
      const after = lines.slice(srcIdx + 1);
      for (const l of after) {
        await db.quoteLines.update(l.id, { sortOrder: (l.sortOrder ?? 0) + 1 });
      }
      setFocusLineId(id);
    } finally {
      markSaved();
    }
  }

  /**
   * Toggle the line's `isOptional` flag. Optional lines render with
   * a badge in the editor + client preview but isPricedLine excludes
   * them from totals, so the total adjusts in one round-trip without
   * any extra recompute on this side.
   *
   * Marking a line optional also stamps `optionalOffered` so the public
   * client link shows a working ON/OFF toggle for it (and clears it when
   * un-marked — a plain line isn't a toggleable add-on). The client link
   * flips `isOptional` to include/exclude; `optionalOffered` is the stable
   * designation that survives those flips.
   *
   * Defensive: if the line is currently part of an alternative group
   * we strip the alternative metadata at the same time — optional +
   * alternative is forbidden by the DB CHECK and would otherwise
   * surface a 23514 error on the next sync.
   */
  async function toggleOptional(line) {
    markSaving();
    try {
      const next = !line.isOptional;
      const patch = next
        ? { isOptional: true, optionalOffered: true, alternativeGroup: null, isSelectedAlternative: false }
        : { isOptional: false, optionalOffered: false };
      await db.quoteLines.update(line.id, patch);
    } finally {
      markSaved();
    }
  }

  /**
   * Clone the line into a new (or existing) alternative group.
   *
   *   - If the source line is standalone, mint a group id, mark the
   *     source as the SELECTED alternative, and insert the duplicate
   *     immediately after it as a non-selected sibling.
   *   - If the source already lives in a group, just insert another
   *     non-selected sibling at the end of the group's run.
   *
   * Same sortOrder-bump pattern as duplicateLine so the new row
   * lands adjacent to its siblings.
   */
  async function addAlternative(line) {
    if (line.isOptional) return;  // mutually exclusive — UI hides this option anyway
    markSaving();
    try {
      await ensurePersisted();
      const groupId = line.alternativeGroup || newId();
      // If this is the FIRST alternative being created on a previously-
      // standalone line, mark the source as the selected one.
      if (!line.alternativeGroup) {
        await db.quoteLines.update(line.id, {
          alternativeGroup: groupId,
          isSelectedAlternative: true,
        });
      }
      // Insert position: directly after the last member of this group
      // currently in the lines list. Keeps siblings contiguous. A FRESH group
      // (the source line not yet in `lines`, e.g. just materialized) yields no
      // indices, so guard the spread: fall back to the source line's own index
      // rather than letting Math.max(...[]) collapse to -Infinity.
      const memberIdxs = lines
        .filter((l) => l.alternativeGroup === groupId || l.id === line.id)
        .map((l) => lines.findIndex((x) => x.id === l.id))
        .filter((i) => i >= 0);
      const srcIdx = lines.findIndex((x) => x.id === line.id);
      const lastIdx = memberIdxs.length ? Math.max(...memberIdxs) : srcIdx;
      const newSortOrder = (lines[lastIdx]?.sortOrder ?? line.sortOrder ?? 0) + 1;
      const newId_ = newId();
      const components = Array.isArray(line.components)
        ? line.components.map((c) => ({ ...c, id: newId() }))
        : [];
      await db.quoteLines.put({
        ...line,
        id: newId_,
        sortOrder: newSortOrder,
        alternativeGroup: groupId,
        isSelectedAlternative: false,
        components,
      });
      // Bump everyone after the insertion point to keep ordering tight.
      for (const l of lines.slice(lastIdx + 1)) {
        await db.quoteLines.update(l.id, { sortOrder: (l.sortOrder ?? 0) + 1 });
      }
      setFocusLineId(newId_);
    } finally {
      markSaved();
    }
  }

  /**
   * Within an alternative group, flip exactly one line to selected.
   * Sets `isSelectedAlternative=true` on the picked line and false on
   * its siblings — the invariant is enforced by this writer; the DB
   * happily allows 0 or N selected sibs at rest, but isPricedLine
   * would then silently count 0 or N priced lines, which is wrong.
   */
  async function selectAlternative(line) {
    if (!line.alternativeGroup) return;
    markSaving();
    try {
      const siblings = lines.filter((l) => l.alternativeGroup === line.alternativeGroup);
      for (const { id, patch } of selectAlternativePatches(siblings, line.id)) {
        await db.quoteLines.update(id, patch);
      }
    } finally {
      markSaved();
    }
  }

  /**
   * Remove `line` from its Conjunto, then HEAL singletons: a Conjunto
   * with exactly one remaining member is meaningless (a "set of 1"), so
   * the lone survivor's `setGroup` is cleared too. Exactly mirrors the
   * alternative singleton-healing in removeLine.
   */
  async function separateFromSet(line) {
    if (!line.setGroup) return;
    markSaving();
    try {
      const groupId = line.setGroup;
      // Leaving the conjunto: it becomes a standalone, non-optional line
      // (its optional state belonged to the group, not the line) — and not a
      // client-toggleable optional either, so clear the offer marker too.
      await db.quoteLines.update(line.id, { setGroup: null, isOptional: false, optionalOffered: false });
      const survivors = lines.filter((l) => l.setGroup === groupId && l.id !== line.id);
      const { linePatches, deleteGroup } = healSetOnRemove(survivors);
      for (const { id, patch } of linePatches) await db.quoteLines.update(id, patch);
      if (deleteGroup) await db.quoteGroups.delete(groupId);
    } finally {
      markSaved();
    }
  }

  /**
   * Toggle a whole Conjunto as optional, persisting the flag on the
   * quote_groups row (source of truth) and materializing is_optional onto the
   * member lines so every total surface (isPricedLine) stays correct without
   * per-surface changes. Only Conjuntos can be optional — an Alternativa
   * always uses at least one option, so it always counts toward the total.
   */
  async function toggleGroupOptional(groupId) {
    if (!groupId) return;
    markSaving();
    try {
      await ensurePersisted();
      const current = groups.find((g) => g.id === groupId);
      const nextOptional = !current?.isOptional;
      await db.quoteGroups.put({
        id: groupId,
        quoteId,
        type: 'set',
        isOptional: nextOptional,
        createdAt: current?.createdAt || Date.now(),
        updatedAt: Date.now(),
      });
      for (const m of lines.filter((l) => l.setGroup === groupId)) {
        if (!!m.isOptional !== nextOptional) {
          await db.quoteLines.update(m.id, { isOptional: nextOptional });
        }
      }
    } finally {
      markSaved();
    }
  }

  /**
   * Join `line` into the Conjunto (take-all set) of the item line DIRECTLY
   * ABOVE it — the per-line "Unir al conjunto de arriba" action.
   *
   *   - If the line above already has a `setGroup`, adopt it; otherwise
   *     mint a new id and stamp it on BOTH lines (a Conjunto is born with
   *     its two members).
   *   - A set is "take ALL", mutually exclusive with optional / alternative,
   *     so those flags are stripped off any line entering it (DB CHECK +
   *     type rule).
   *   - Members are already contiguous because we only ever join the line
   *     immediately above; no reorder needed.
   *
   * No-op when there's no line above or the line above is a section — the
   * row hides the action via `canJoinAbove`, but we guard here too.
   */
  async function joinSet(line) {
    markSaving();
    try {
      const idx = lines.findIndex((l) => l.id === line.id);
      if (idx <= 0) return;
      const above = lines[idx - 1];
      if (!above || above.kind === LINE_KIND_SECTION) return;
      const groupId = above.setGroup || newId();
      // A line joining an OPTIONAL conjunto inherits its optional state
      // (materialized so isPricedLine keeps the total correct). A brand-new
      // set is not optional.
      const inheritOptional = isGroupOptional(groups, above.setGroup);
      if (!above.setGroup) {
        await db.quoteLines.update(above.id, {
          setGroup: groupId,
          isOptional: false,
          optionalOffered: false,
          alternativeGroup: null,
          isSelectedAlternative: false,
        });
      }
      // A set member is never a standalone client-toggleable optional — its
      // optionality (if any) is the GROUP's, so drop the per-line offer marker.
      await db.quoteLines.update(line.id, {
        setGroup: groupId,
        isOptional: inheritOptional,
        optionalOffered: false,
        alternativeGroup: null,
        isSelectedAlternative: false,
      });
    } finally {
      markSaved();
    }
  }

  /**
   * Remove `line` from whatever group it's in — a Conjunto OR an
   * Alternativa — and heal singletons. The multi-select bar handles
   * CREATION; this is the single per-line "leave the group" handler the
   * row's controls call. For a set it delegates to separateFromSet (set
   * singleton-healing). For an alternative it clears the line's
   * alternativeGroup/selection flag and, if exactly one sibling survives,
   * promotes that survivor to standalone (mirrors removeLine's healing) —
   * and if the removed line was the selected one, promotes the first
   * survivor of a still-valid group so exactly one stays priced.
   */
  async function ungroupLine(line) {
    if (line.setGroup) {
      await separateFromSet(line);
      return;
    }
    if (!line.alternativeGroup) return;
    markSaving();
    try {
      await db.quoteLines.update(line.id, {
        alternativeGroup: null,
        isSelectedAlternative: false,
      });
      const survivors = lines.filter(
        (l) => l.alternativeGroup === line.alternativeGroup && l.id !== line.id,
      );
      for (const { id, patch } of healAlternativeOnRemove(survivors, !!line.isSelectedAlternative)) {
        await db.quoteLines.update(id, patch);
      }
    } finally {
      markSaved();
    }
  }

  async function removeLine(line) {
    markSaving();
    try {
      await db.quoteLines.delete(line.id);
      // Maintain the alternative-group invariant after the deletion: a
      // group is either ≥2 members with exactly one selected, or it
      // doesn't exist. Every surface (editor, preview, PDF, pricing)
      // keys off `alternativeGroup`, so healing it here is what makes
      // "Alternativa 1 de 1" impossible. We capture the sibling we
      // touch so undo can put the group back exactly as it was.
      // Heal the alternative-group invariant (lone survivor → standalone;
      // removed-the-selected → promote the first survivor). The pure helper
      // decides the patch; we capture the survivor's ORIGINAL state first so
      // undo can put the group back exactly as it was.
      let healedSibling = null;
      if (line.alternativeGroup) {
        const siblings = lines.filter(
          (l) => l.alternativeGroup === line.alternativeGroup && l.id !== line.id,
        );
        const [altPatch] = healAlternativeOnRemove(siblings, !!line.isSelectedAlternative);
        if (altPatch) {
          healedSibling = siblings.find((s) => s.id === altPatch.id) || null;
          await db.quoteLines.update(altPatch.id, altPatch.patch);
        }
      }
      // Same singleton-healing for Conjuntos (sets): a set left with one
      // member is meaningless, so clear the lone survivor's setGroup and
      // delete the group row. Captured separately from the alternative sibling
      // so undo can restore each independently (a line is never both at once).
      let healedSetSibling = null;
      if (line.setGroup) {
        const setSurvivors = lines.filter(
          (l) => l.setGroup === line.setGroup && l.id !== line.id,
        );
        const { linePatches, deleteGroup } = healSetOnRemove(setSurvivors);
        if (linePatches.length) {
          healedSetSibling = setSurvivors.find((s) => s.id === linePatches[0].id) || null;
          await db.quoteLines.update(linePatches[0].id, linePatches[0].patch);
        }
        if (deleteGroup) await db.quoteGroups.delete(line.setGroup);
      }
      const label = line.kind === LINE_KIND_SECTION
        ? `Sección "${line.name || 'sin nombre'}" eliminada`
        : `Artículo "${line.name || line.reference || 'sin nombre'}" eliminado`;
      showUndo(label, async () => {
        // Restore the row at its original sort_order. The other rows kept
        // their positions, so the slot is still empty.
        await db.quoteLines.put(line);
        // Roll back the invariant repair so the group reads exactly as
        // it did before the delete.
        if (healedSibling) {
          await db.quoteLines.update(healedSibling.id, {
            alternativeGroup: healedSibling.alternativeGroup,
            isSelectedAlternative: !!healedSibling.isSelectedAlternative,
          });
        }
        if (healedSetSibling) {
          await db.quoteLines.update(healedSetSibling.id, {
            isOptional: !!healedSetSibling.isOptional,
            setGroup: healedSetSibling.setGroup,
          });
        }
      });
    } finally {
      markSaved();
    }
  }

  async function reorderLines(orderedIds) {
    markSaving();
    try {
      const idToLine = new Map(lines.map((l) => [l.id, l]));
      for (let i = 0; i < orderedIds.length; i++) {
        const l = idToLine.get(orderedIds[i]);
        if (!l) continue;
        if (l.sortOrder !== i) await db.quoteLines.update(l.id, { sortOrder: i });
      }
    } finally {
      markSaved();
    }
  }

  return {
    // save status + newest-line focus
    saving, savedAt, focusLineId,
    // history
    canUndo, canRedo, undo, redo, hx, undoToast,
    // mutations
    updateQuote, addLine, addSection, updateLine, duplicateLine,
    toggleOptional, addAlternative, selectAlternative, separateFromSet,
    toggleGroupOptional, joinSet, ungroupLine, removeLine, reorderLines,
    // line ⇄ component moves
    moveTargetsFor, moveLineIntoCompound, extractFromLine,
  };
}
