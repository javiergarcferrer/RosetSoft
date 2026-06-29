import { useContext, useState } from 'react';
import { PackageSearch, Hash, Boxes, GitFork, PlusCircle, Sparkles, Check, Pencil, Palette, GripVertical } from 'lucide-react';
import QuoteLineItem from './QuoteLineItem.jsx';
import SectionDivider from './SectionDivider.jsx';
import AddSourceButtons from './AddSourceButtons.jsx';
import SwatchPicker from './SwatchPicker.jsx';
import ImageView from '../ImageView.jsx';
import { FamiliesContext } from './FamiliesContext.js';
import { CompanyDiscountContext } from './CompanyDiscountContext.js';
import { useQuoteActions } from './QuoteActionsContext.js';
import { LINE_KIND_SECTION } from '../../lib/constants.js';
import {
  setSubtotal, alternativeSubtotal, groupRuns,
  selectedAlternative, lineTotal, isRangeLine, lineTotalRange,
  setSubtotalRange, lineHasRange, isCompoundLine, companyLineDiscountPct,
} from '../../lib/pricing.js';
import { resolveLineList } from '../../core/quote/views/editor.js';
import { isGroupOptional } from '../../lib/quoteGroups.js';
import { repriceComponentsAtGrade } from '../../lib/catalog.js';
import { formatMoney } from '../../lib/format.js';

/**
 * Renders the ordered list of quote lines (mixed items + sections) and owns
 * the drag-reorder interaction + the Conjunto between-lines connector.
 *
 * GROUP CARDS (the gold-standard pattern, mirroring Compuesto):
 *   Contiguous runs of lines sharing the same `setGroup` (Conjunto) or
 *   `alternativeGroup` (Alternativa) are wrapped in a bordered container
 *   CARD — a group header eyebrow on top, the member rows inside, and one
 *   footer total at the bottom. Run detection is `groupRuns(lines)` in
 *   lib/pricing (shared with the preview/PDF surfaces). A member can itself
 *   be a Compuesto; the card just nests the compound card cleanly. The card
 *   owns the accent + footer, so the member rows inside DON'T re-draw their
 *   own group border/footer (suppressed via `insideGroupCard`).
 *     - Conjunto: violet accent, footer "Total del conjunto" = setSubtotal
 *       (sum of every member's line total — take-all).
 *     - Alternativa: brand accent, footer = the SELECTED option's line total
 *       (alternativeSubtotal); non-selected members stay dimmed with a radio.
 *
 * CONJUNTO via BETWEEN-LINES CONNECTOR (set creation):
 *   In the gap between two ADJACENT item lines (both non-section, not already
 *   in the same setGroup) we render a slim centered "⊕ Unir en conjunto"
 *   chip. Clicking it joins those two neighbours into a Conjunto by calling
 *   onJoinSet on the LOWER line — joinSet() in QuoteBuilder stamps a shared
 *   setGroup on it and the line directly above. The connector is suppressed
 *   inside a set GroupCard (same-setGroup members) and next to a section.
 *   Leaving a set ("Separar del conjunto") lives in the per-line footer.
 *
 * Drag-reorder (per line):
 *   - HTML5 drag-and-drop (desktop only; mobile users add a new line where
 *     they want it and delete the old one).
 *   - Drop indicator: thin brand-color bar above the row being hovered.
 *   - Sort order renormalised after a drop. A reorder that splits a group
 *     simply yields the new contiguous runs the card layout reflects.
 */
export default function LineItemList({ lines, groups, quote, focusLineId }) {
  // Editor actions arrive via context (served by Workspace) rather than being
  // threaded through LineItemsCard — see QuoteActionsContext.
  const {
    onChangeLine, onRemoveLine, onDuplicateLine, onReorder,
    onToggleOptional, onAddAlternative, onSelectAlternative,
    onSeparateFromSet, onUngroup, onJoinSet, onToggleGroupOptional,
    onAddSection, onOpenCatalog, onOpenInventory,
    // Drag a top-level line INTO a compound/modular to absorb it. getMoveTargets
    // owns every gate (sections, grouped lines, compound→plain) and returns the
    // eligible target ids for THIS source; an empty list ⇒ no drop zones light up.
    getMoveTargets, onMoveLineIntoCompound,
  } = useQuoteActions();
  // ViewModel — position maps ("Alternativa/Conjunto N de M") + per-section
  // subtotals, all derived by the quote Model (core/quote/views/editor); the
  // view reads them and re-scans nothing itself.
  const { groupInfo, setInfo, sectionSubtotals } = resolveLineList({ lines });

  const currency = quote?.currencyCode || 'USD';
  const rates = quote?.rates || { USD: 1 };
  const byId = new Map(lines.map((l) => [l.id, l]));
  // Catalog families (keyed by SKU root) — used by applyMaterialToSet to reprice
  // a material-less RANGE member against its own model at the chosen grade,
  // exactly as a single line's GradeFabricRow.commit does. Consumed via context
  // (the same escape hatch QuoteLineItem uses) so we don't thread it as a prop.
  const families = useContext(FamiliesContext);
  // Company (house) account: the flat fallback discount the subtree reads. Each
  // line below re-provides its OWN per-product rate (companyLineDiscountPct) so
  // the editor shows each product's real margin, not this single number.
  const flatCompanyPct = useContext(CompanyDiscountContext);

  // "Aplicar material a todo" on a Conjunto header — stamp the chosen grade +
  // fabric (subtype) and swatch onto EVERY member line of the set, and reprice a
  // material-less RANGE member against its own model at the grade (dropping its
  // range) so a member is never left both ranged AND priced and the set total
  // re-sums correctly. A compound member carries no line-level material, so the
  // pick is propagated into its components (mirroring applyMaterialToAllComponents)
  // rather than written on the parent. Each member is written through the
  // existing onChangeLine action, so the writes join undo/redo + autosave.
  function applyMaterialToSet(groupId, picked) {
    if (!groupId || !picked) return;
    const { grade, fabric, swatchImageId } = picked;
    const pick = { grade, fabric, swatchImageId: swatchImageId ?? null };
    const members = lines.filter((l) => l.setGroup === groupId && l.kind !== LINE_KIND_SECTION);
    for (const m of members) {
      if (isCompoundLine(m)) {
        // Apply to every component of a compound member (its own material lives
        // per-component, not on the parent line) — the SAME shared reprice-at-
        // grade Model helper applyMaterialToAllComponents uses, so the two paths
        // can't drift (each component repriced to its own model at the grade).
        onChangeLine(m.id, { components: repriceComponentsAtGrade(m.components, pick, families) });
        continue;
      }
      // A simple line is repriced like a one-element component list, so it goes
      // through the identical Model rule (subtype + swatch + reference/price +
      // range drop) as a compound's pieces and GradeFabricRow.commit.
      const [next] = repriceComponentsAtGrade([m], pick, families);
      const patch = {
        subtype: next.subtype,
        swatchImageId: next.swatchImageId,
        reference: next.reference,
        unitPrice: next.unitPrice,
      };
      if (grade && (m.priceMin != null || m.priceMax != null)) {
        patch.priceMin = null;
        patch.priceMax = null;
      }
      onChangeLine(m.id, patch);
    }
  }

  // -------- drag-reorder --------
  // A drag carries a BLOCK of line ids: one for a normal line, the whole member
  // run for a group card (Conjunto / Alternativa) grabbed by its handle — so a
  // pick-one Alternativa moves as a unit (e.g. INTO a section) instead of being
  // un-draggable in its compact pick-pane. The block keeps its order + stays
  // contiguous, so groupRuns still reads it as one group after the drop.
  const [dragging, setDragging] = useState(null);   // { ids: string[] } | null
  const [dropTargetId, setDropTargetId] = useState(null);
  // Alternatives render as a compact pick-pane (radio + summary + price) so the
  // group reads like the client quote-pane; the dealer taps "Editar" to expand
  // ONE option to its full editor inline. `expandedAltId` is that option's id.
  const [expandedAltId, setExpandedAltId] = useState(null);
  // The compound card a dragged line is currently hovering for ABSORB (vs the
  // reorder drop-bar). Separate from dropTargetId so the two gestures never
  // fight: a valid target shows an absorb overlay; everything else reorders.
  const [absorbHoverId, setAbsorbHoverId] = useState(null);
  const draggingIds = dragging?.ids || null;
  const isDraggingId = (id) => !!draggingIds && draggingIds.includes(id);
  // Absorb is a single-line gesture (you don't drag a whole group into a
  // compound). Resolve the dragged source + the set of compounds that accept
  // it, so each eligible card can light up a drop zone mid-drag.
  const dragSource = draggingIds && draggingIds.length === 1 ? byId.get(draggingIds[0]) : null;
  const absorbTargetIds = dragSource && getMoveTargets
    ? new Set(getMoveTargets(dragSource).map((t) => t.id))
    : null;

  function onDragStart(e, ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    setDragging({ ids: list });
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', list[0] || ''); } catch {}
  }
  function onDragEnd() {
    setDragging(null);
    setDropTargetId(null);
    setAbsorbHoverId(null);
  }
  function onDragOver(e, id) {
    if (!draggingIds || isDraggingId(id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetId(id);
    // Hovering a plain reorder zone — not an absorb target.
    setAbsorbHoverId(null);
  }
  // Drop a dragged line INTO a compound (the absorb overlay's own handlers).
  function onAbsorbOver(e, id) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setAbsorbHoverId(id);
    setDropTargetId(null);
  }
  function onAbsorbDrop(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const src = dragSource;
    setDragging(null);
    setDropTargetId(null);
    setAbsorbHoverId(null);
    if (src && onMoveLineIntoCompound) onMoveLineIntoCompound(id, src);
  }
  function onDrop(e, id) {
    e.preventDefault();
    const ids = draggingIds;
    setDragging(null);
    setDropTargetId(null);
    setAbsorbHoverId(null);
    if (!ids || ids.includes(id)) return;
    // Pull the moved block out (it keeps its document order, so a group stays a
    // contiguous run), locate the target in what REMAINS, and splice the block
    // in just before it — direction-agnostic, since the drop indicator always
    // sits above the target row.
    const moveSet = new Set(ids);
    const moved = lines.filter((l) => moveSet.has(l.id));
    const remaining = lines.filter((l) => !moveSet.has(l.id));
    const at = remaining.findIndex((l) => l.id === id);
    if (at === -1) return;
    const next = [...remaining.slice(0, at), ...moved, ...remaining.slice(at)];
    onReorder(next.map((l) => l.id));
  }

  if (lines.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-ink-100 text-ink-500 mb-3">
          <PackageSearch size={18} />
        </div>
        <div className="text-sm font-medium text-ink-900">Empieza tu cotización</div>
        <div className="text-xs text-ink-500 mt-1 max-w-sm mx-auto">
          Agrega un producto del <b>catálogo</b> o del <b>inventario</b> para empezar.
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <AddSourceButtons onOpenCatalog={onOpenCatalog} onOpenInventory={onOpenInventory} variant="cta" />
          <button type="button" onClick={onAddSection} className="btn-ghost">
            <Hash size={14} /> Sección
          </button>
        </div>
      </div>
    );
  }

  // Partition the flat list into contiguous runs (set / alternative /
  // single) — the single source of truth shared with preview/PDF.
  const runs = groupRuns(lines);

  // Renders one line row (item or section) + its drag/select chrome. Shared
  // by both the single-run path and the group-card members so the row markup
  // stays identical inside and outside a card.
  function renderRow(l, { insideGroupCard }) {
    const isSection = l.kind === LINE_KIND_SECTION;
    const isDragging = isDraggingId(l.id);
    const isDropTarget = dropTargetId === l.id && !isDraggingId(l.id);
    // This row is an eligible ABSORB target for the line currently being
    // dragged (a top-level compound/modular, not the source itself, not a
    // member inside a group card). The overlay below captures the drop.
    const isAbsorbTarget = !insideGroupCard && !!absorbTargetIds && absorbTargetIds.has(l.id) && !isDragging;
    const absorbHot = absorbHoverId === l.id;
    const handleProps = {
      draggable: true,
      onDragStart: (e) => onDragStart(e, l.id),
      onDragEnd,
      'data-dragging': isDragging ? 'true' : 'false',
    };
    // Joining a set now happens via the between-lines connector chip (see
    // SetConnector below), which calls onJoinSet on the LOWER of the two
    // neighbours — joining it with the line directly above. The per-line row
    // no longer carries a "Unir al conjunto de arriba" action.

    return (
      <div
        key={l.id}
        onDragOver={(e) => onDragOver(e, l.id)}
        onDrop={(e) => onDrop(e, l.id)}
        className={`relative ${isDragging ? 'opacity-40' : ''}`}
      >
        {isDropTarget && (
          <div className="absolute left-0 right-0 -top-px h-0.5 bg-brand-500 z-10 pointer-events-none" />
        )}
        {/* ABSORB drop zone — overlays an eligible compound/modular card while a
            line is being dragged, so dropping here nests the line as a component
            / module (instead of reordering). Faint ring on every valid target;
            the hovered one fills in and names itself. Captures the drop above
            the row's reorder handlers (z-20, own stopPropagation handlers). */}
        {isAbsorbTarget && (
          <div
            onDragOver={(e) => onAbsorbOver(e, l.id)}
            onDrop={(e) => onAbsorbDrop(e, l.id)}
            className={`absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed transition-colors ${
              absorbHot
                ? 'border-brand-500 bg-brand-50/95'
                : 'border-brand-300/70 bg-brand-50/30'
            }`}
          >
            <span className={`text-xs font-semibold text-brand-700 px-3 text-center transition-opacity ${absorbHot ? 'opacity-100' : 'opacity-0'}`}>
              Soltar para añadir a {l.name || 'este producto'}
            </span>
          </div>
        )}
        {isSection ? (
          <SectionDivider
            line={l}
            onChange={(patch) => onChangeLine(l.id, patch)}
            onRemove={() => onRemoveLine(l)}
            autoFocus={l.id === focusLineId}
            dragHandleProps={handleProps}
            subtotalLabel={
              sectionSubtotals.get(l.id) > 0
                ? formatMoney(sectionSubtotals.get(l.id), currency, rates)
                : null
            }
          />
        ) : (
          // Each line reads its OWN company-account cost rate (its product's
          // catalog margin) — re-provided here so the line editor, its badge and
          // its breakdown all read at that product's real cost, not a flat %.
          <CompanyDiscountContext.Provider value={companyLineDiscountPct(l, flatCompanyPct)}>
            <QuoteLineItem
              line={l}
              quote={quote}
              onChange={(patch) => onChangeLine(l.id, patch)}
              onRemove={() => onRemoveLine(l)}
              onDuplicate={() => onDuplicateLine(l)}
              onToggleOptional={() => onToggleOptional?.(l)}
              onAddAlternative={() => onAddAlternative?.(l)}
              onSelectAlternative={() => onSelectAlternative?.(l)}
              onSeparateFromSet={() => onSeparateFromSet?.(l)}
              onUngroup={() => onUngroup?.(l)}
              insideGroupCard={insideGroupCard}
              groupInfo={groupInfo.get(l.id)}
              setInfo={setInfo.get(l.id)}
              autoFocus={l.id === focusLineId}
              dragHandleProps={handleProps}
            />
          </CompanyDiscountContext.Provider>
        )}
      </div>
    );
  }

  // Renders one run (a flat list of single rows OR a group card). Returns an
  // array of nodes so the caller can interleave between-line connectors.
  function renderRun(run) {
    if (run.type === 'single') {
      // A "single" run can hold several consecutive ungrouped / section
      // lines. Interleave a connector between each adjacent pair so two
      // neighbouring item lines can be joined into a Conjunto in one tap.
      const ids = run.lineIds;
      const nodes = [];
      ids.forEach((id, i) => {
        const l = byId.get(id);
        nodes.push(renderRow(l, { insideGroupCard: false }));
        const next = ids[i + 1] ? byId.get(ids[i + 1]) : null;
        if (next && canConnectSet(l, next)) {
          nodes.push(
            <SetConnector key={`conn-${id}-${next.id}`} onJoin={() => onJoinSet?.(next)} />,
          );
        }
      });
      return nodes;
    }

    // Group run → a container card wrapping the member rows.
    const members = run.lineIds.map((id) => byId.get(id)).filter(Boolean);
    const isSet = run.type === 'set';
    const accent = isSet ? 'violet' : 'brand';
    // Only Conjuntos can be optional — an Alternativa always uses one option.
    const optional = isSet && isGroupOptional(groups, run.groupId);

    // Footer total — range-aware for an Alternativa whose SELECTED option is
    // material-less ("min – max" instead of a single figure).
    const fmt = (v) => formatMoney(v, currency, rates);
    let footerValueLabel;
    if (isSet) {
      // Range-aware: a Conjunto widens when ANY take-all member is material-less
      // (a range line, or a compound with a range component).
      const sr = setSubtotalRange(lines, run.groupId);
      footerValueLabel = sr.max > sr.min
        ? `${fmt(sr.min)} – ${fmt(sr.max)}`
        : fmt(setSubtotal(lines, run.groupId));
    } else {
      const sel = selectedAlternative(lines, run.groupId);
      // lineHasRange (not isRangeLine) so a COMPOUND selected alternative with a
      // material-less component rolls up as a range too.
      if (sel && lineHasRange(sel)) {
        const r = lineTotalRange(sel);
        footerValueLabel = `${fmt(r.min)} – ${fmt(r.max)}`;
      } else {
        footerValueLabel = fmt(alternativeSubtotal(lines, run.groupId));
      }
    }

    // Members: a Conjunto keeps the full editor rows (every piece is priced and
    // edited); an Alternativa renders the compact pick-pane — radio + summary +
    // price — expanding ONE option to its full editor inline on "Editar".
    const memberNodes = isSet
      ? members.map((l) => renderRow(l, { insideGroupCard: true }))
      : members.map((l) => {
          const expanded = expandedAltId === l.id;
          return (
            <AlternativeOption
              key={l.id}
              line={l}
              fmt={fmt}
              groupInfo={groupInfo.get(l.id)}
              selected={!!l.isSelectedAlternative}
              expanded={expanded}
              onSelect={() => onSelectAlternative?.(l)}
              onToggleEdit={() => setExpandedAltId((id) => (id === l.id ? null : l.id))}
            >
              {expanded ? renderRow(l, { insideGroupCard: true }) : null}
            </AlternativeOption>
          );
        });

    const groupKey = `grp-${run.groupId}-${run.start}`;
    const firstId = run.lineIds[0];
    const cardProps = {
      type: run.type,
      accent,
      memberCount: members.length,
      optional,
      onToggleOptional:
        isSet && onToggleGroupOptional ? () => onToggleGroupOptional(run.groupId) : undefined,
      // Conjunto only: apply one chosen material to every member line. An
      // Alternativa is a pick-one of distinct options, so a bulk material set
      // wouldn't make sense there.
      onApplyMaterial: isSet ? (picked) => applyMaterialToSet(run.groupId, picked) : undefined,
      footerLabel: isSet ? 'Total del conjunto' : 'Total',
      footerValue: footerValueLabel,
      // The whole group drags as one unit (all member ids move together).
      dragHandleProps: { draggable: true, onDragStart: (e) => onDragStart(e, run.lineIds), onDragEnd },
    };
    const body = <ul className="divide-y divide-ink-100">{memberNodes}</ul>;

    // An Alternativa's compact options aren't individual drop targets (a
    // Conjunto's full rows ARE), so the CARD itself must accept a drop — that's
    // what lets the pick-one block be dragged onto another row, e.g. INTO a
    // section. A Conjunto needs no wrapper: dropping before its first member row
    // already lands a block before the group.
    if (run.type === 'alternative') {
      const groupDragging = isDraggingId(firstId);
      return (
        <div
          key={groupKey}
          onDragOver={(e) => onDragOver(e, firstId)}
          onDrop={(e) => onDrop(e, firstId)}
          className={`relative ${groupDragging ? 'opacity-40' : ''}`}
        >
          {dropTargetId === firstId && !groupDragging && (
            <div className="absolute left-0 right-0 -top-px h-0.5 bg-brand-500 z-10 pointer-events-none" />
          )}
          <GroupCard {...cardProps}>{body}</GroupCard>
        </div>
      );
    }
    return <GroupCard key={groupKey} {...cardProps}>{body}</GroupCard>;
  }

  return (
    <div className="group/list">
      {/* A gap-separated stack (not edge-to-edge hairline rows): each top-level
          line / group renders as its own card with breathing room between them,
          so the eye parses the quote as discrete units even when scrolling fast.
          Sections stay full-bleed (negative margin) to read as strong dividers. */}
      <ul className="flex flex-col gap-2.5 sm:gap-3 p-2.5 sm:p-3">
        {runs.map((run, ri) => {
          const node = renderRun(run);
          // Connector at the boundary between this run and the next, joining
          // the LAST line of this run with the FIRST line of the next. Lets a
          // standalone line snap onto the row that opens the next block (and
          // vice-versa) without dragging. Suppressed when either boundary
          // line is a section or the two already share a setGroup.
          const nextRun = runs[ri + 1];
          let connector = null;
          if (nextRun) {
            const upper = byId.get(run.lineIds[run.lineIds.length - 1]);
            const lower = byId.get(nextRun.lineIds[0]);
            if (upper && lower && canConnectSet(upper, lower)) {
              connector = (
                <SetConnector
                  key={`conn-${upper.id}-${lower.id}`}
                  onJoin={() => onJoinSet?.(lower)}
                />
              );
            }
          }
          return [node, connector];
        })}
      </ul>
    </div>
  );
}

// Two adjacent lines can be offered the "Unir en conjunto" connector when
// joining them is CLEAN and non-destructive. Clicking fires joinSet(lower),
// which stamps `lower` (and, when standalone, `upper`) with a shared setGroup
// and strips conflicting flags. So we only show it when:
//   - both are real item lines (not sections),
//   - the LOWER line is ungrouped (no setGroup / alternativeGroup) — otherwise
//     a click would yank it out of its existing group, and
//   - the UPPER line isn't in an alternative group — otherwise joining a
//     standalone lower would strip the upper out of its alternatives.
// (Adding a line to an EXISTING set still works: an ungrouped line below a set
// member adopts that member's setGroup. To extend a set the dealer keeps the
// new line just under the set.)
function canConnectSet(upper, lower) {
  if (!upper || !lower) return false;
  if (upper.kind === LINE_KIND_SECTION || lower.kind === LINE_KIND_SECTION) return false;
  if (lower.setGroup || lower.alternativeGroup) return false;
  if (upper.alternativeGroup) return false;
  return true;
}

/**
 * Slim centered connector that sits in the GAP between two adjacent item
 * lines and offers to join them into a Conjunto. A hairline rule with a small
 * "⊕ Unir en conjunto" chip floated over its midpoint. Unobtrusive at rest;
 * the chip strengthens on hover/focus on desktop and stays tappable on touch.
 * Clicking calls onJoin, which fires joinSet on the LOWER line (joining it
 * with the line directly above — the existing handler).
 */
function SetConnector({ onJoin }) {
  // A real (short) row, not a zero-height overlay, so the chip lives in its
  // own space instead of overlapping the footer above or the row below. The
  // list's own `divide-y` hairlines bracket this short gap; the chip floats
  // centred in it. Unobtrusive at rest (60% on desktop), it lifts to full on
  // hover/focus and is always full + tappable on touch.
  return (
    <li className="relative list-none py-1.5 flex items-center justify-center">
      <button
        type="button"
        onClick={onJoin}
        className="chip-action opacity-60 hover:opacity-100 focus:opacity-100 coarse:opacity-100 coarse:px-4"
        title="Unir esta línea con la de arriba en un conjunto que se vende junto"
      >
        <PlusCircle size={11} className="opacity-80" aria-hidden />
        Unir en conjunto
      </button>
    </li>
  );
}

/**
 * Container card wrapping a contiguous group run (Conjunto or Alternativa).
 * Mirrors the Compuesto card's visual language: a bordered card with a
 * header eyebrow on top, the member rows inside, and one footer total at
 * the bottom. The accent color distinguishes a set (violet) from an
 * alternative (brand). The card owns the border + footer so the member rows
 * inside don't re-draw their own.
 */
function GroupCard({ type, accent, memberCount, optional, onToggleOptional, onApplyMaterial, footerLabel, footerValue, dragHandleProps, children }) {
  const isSet = type === 'set';
  // "Aplicar material a todo" picker for a Conjunto header (set only).
  const [materialOpen, setMaterialOpen] = useState(false);
  // Tailwind needs literal class names — branch rather than interpolate.
  const ring = isSet ? 'border-ink-300' : 'border-brand-300';
  const headBg = isSet ? 'bg-ink-50' : 'bg-brand-50/50';
  const footBg = isSet ? 'bg-ink-50/70' : 'bg-brand-50/40';
  const eyebrowColor = isSet ? 'text-ink-600' : 'text-brand-700';
  const Icon = isSet ? Boxes : GitFork;
  const eyebrow = isSet
    ? (optional ? 'Conjunto opcional' : 'Conjunto')
    : 'Alternativas — elige una';
  return (
    // The list owns the spacing now; the card sits flush with the single-line
    // cards. A heavier border-2 (vs the hairline of a plain line) marks this as a
    // CONTAINER of several lines, one clear step up the hierarchy.
    <div>
      {/* No overflow:hidden (hard rule — silent clipping): the header/footer
          bands carry their own matched inner radius (12px outer − 2px border
          = 10px) so their tinted backgrounds follow the card's corners. */}
      <div className={`rounded-xl border-2 ${ring} bg-surface shadow-sm ${optional ? 'border-dashed' : ''}`}>
        <div className={`${headBg} rounded-t-[10px] px-4 py-2 flex flex-wrap items-center gap-x-2 gap-y-1.5`}>
          <span className="inline-flex items-center gap-1.5 min-w-0 flex-shrink">
            {dragHandleProps && (
              <span
                {...dragHandleProps}
                className="hidden fine:inline-flex items-center cursor-grab text-ink-300 hover:text-ink-700 -ml-1 flex-shrink-0"
                title="Arrastra el grupo para reordenarlo"
                aria-label="Arrastrar el grupo"
              >
                <GripVertical size={13} />
              </span>
            )}
            <span className={`inline-flex items-center gap-1.5 eyebrow font-semibold tracking-[0.06em] ${eyebrowColor} min-w-0`}>
              <Icon size={13} className="opacity-80 flex-shrink-0" aria-hidden />
              <span className="min-w-0">{eyebrow}</span>
            </span>
          </span>
          <span className="inline-flex flex-wrap items-center gap-2 ml-auto min-w-0">
            {/* Top-level "apply material to all" — one pick stamps the chosen
                grade + fabric + swatch onto every member line of the Conjunto
                (repricing material-less members against their own model). */}
            <span className="eyebrow-xs font-medium tracking-wide text-ink-400 tabular-nums whitespace-nowrap">
              {memberCount} {isSet ? 'piezas' : 'opciones'}
            </span>
            {onApplyMaterial && (
              <button
                type="button"
                onClick={() => setMaterialOpen(true)}
                className="chip-action"
                title="Elegir una tela y aplicarla a todas las piezas del conjunto"
              >
                <Palette size={11} className="opacity-70" aria-hidden />
                Aplicar material
              </button>
            )}
            {onToggleOptional && (
              <button
                type="button"
                onClick={onToggleOptional}
                aria-pressed={!!optional}
                className={`chip-action ${
                  optional ? 'text-brand-700 bg-brand-50 border-brand-200 hover:bg-brand-100 hover:border-brand-300' : ''
                }`}
                title={optional
                  ? 'Quitar opcional — el grupo vuelve a sumar al total'
                  : (isSet
                    ? 'Marcar el conjunto como opcional (todo o nada, no suma al total)'
                    : 'Permitir no elegir ninguna (el grupo no suma al total)')}
              >
                <Sparkles size={11} className="opacity-70" aria-hidden />
                {optional ? 'Opcional' : 'Hacer opcional'}
              </button>
            )}
          </span>
        </div>
        {children}
        <div className={`${footBg} rounded-b-[10px] border-t-2 ${ring} px-4 py-2.5 flex flex-wrap items-center gap-x-2 gap-y-1`}>
          <span className={`inline-flex items-center gap-1.5 eyebrow font-semibold tracking-[0.06em] ${eyebrowColor} min-w-0 flex-shrink`}>
            <Icon size={12} className="opacity-80 flex-shrink-0" aria-hidden />
            <span className="min-w-0">{footerLabel}</span>
            {optional && <span className="normal-case font-normal text-ink-400 whitespace-nowrap">· no incluido</span>}
          </span>
          <span className="text-sm font-semibold text-ink-900 tabular-nums whitespace-nowrap ml-auto flex-shrink-0">
            {footerValue}
          </span>
        </div>
      </div>
      {/* Conjunto material picker. A set mixes models, so there's no single
          offered-fabric allowlist to honor here (nameFilter omitted); the pick
          is applied to every member via onApplyMaterial. */}
      {onApplyMaterial && (
        <SwatchPicker
          open={materialOpen}
          onClose={() => setMaterialOpen(false)}
          onSelect={(picked) => onApplyMaterial(picked)}
        />
      )}
    </div>
  );
}

/**
 * Compact alternative-option row — the quote-pane "pick one" treatment for the
 * editor. A radio selects the option (flipping the group's total); a thumbnail
 * + name + material + price summarise it; "Editar" expands the full
 * QuoteLineItem inline (passed as `children`). A material-less option shows its
 * price RANGE. Non-selected options dim so the chosen one wins the eye,
 * mirroring the client preview.
 */
function AlternativeOption({ line, fmt, groupInfo, selected, expanded, onSelect, onToggleEdit, children }) {
  if (expanded) {
    return (
      <li className="list-none bg-brand-50/20">
        <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
          <span className="eyebrow-xs text-brand-700 font-semibold">
            Editando alternativa{groupInfo ? ` ${groupInfo.index}/${groupInfo.total}` : ''}
          </span>
          <button
            type="button"
            onClick={onToggleEdit}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-700 hover:text-brand-900 hover:bg-brand-100/60 active:bg-brand-100 rounded-md px-2 py-1 coarse:min-h-11 transition-colors"
          >
            <Check size={12} aria-hidden /> Listo
          </button>
        </div>
        {children}
      </li>
    );
  }
  // lineHasRange (not isRangeLine) so a COMPOUND alternative made of a
  // material-less piece shows its "min – max" in the collapsed pick-pane too.
  const ranged = lineHasRange(line);
  const r = ranged ? lineTotalRange(line) : null;
  const priceLabel = r ? `${fmt(r.min)} – ${fmt(r.max)}` : fmt(lineTotal(line));
  // A compound option is a take-all bundle (a "conjunto") used as an
  // alternative — label it by its piece count, not the (empty) line subtype,
  // so it doesn't misread as "Sin material".
  const compound = isCompoundLine(line);
  const pieces = compound ? (line.components || []).length : 0;
  const material = compound
    ? `Compuesto · ${pieces} pieza${pieces === 1 ? '' : 's'}`
    : (line.subtype || (ranged ? 'Sin material · rango' : 'Sin material'));
  const dim = selected ? '' : 'opacity-60';
  return (
    <li className={`list-none flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 transition-colors ${selected ? 'bg-brand-50/40' : 'hover:bg-ink-50'}`}>
      <button
        type="button"
        onClick={onSelect}
        role="radio"
        aria-checked={selected}
        aria-label="Seleccionar esta alternativa"
        title={selected ? 'Alternativa seleccionada' : 'Seleccionar esta alternativa'}
        className="inline-flex items-center justify-center coarse:min-w-11 coarse:min-h-11 flex-shrink-0"
      >
        {/* Hit target wraps the visual circle: the glyph stays a quiet 20px
            radio while the button meets the 44px touch minimum on coarse. */}
        <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full border-2 transition-colors ${
          selected ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300 bg-surface hover:border-brand-400'
        }`}>
          {selected && <Check size={11} strokeWidth={3} aria-hidden />}
        </span>
      </button>
      {line.imageId ? (
        <ImageView
          id={line.imageId}
          alt={line.name || ''}
          className={`w-12 h-12 rounded-md object-contain bg-ink-50 border border-ink-100 flex-shrink-0 ${dim}`}
        />
      ) : (
        <div className="w-12 h-12 rounded-md bg-ink-50 border border-ink-100 flex-shrink-0" />
      )}
      <button type="button" onClick={onSelect} className={`min-w-0 flex-1 text-left ${dim}`}>
        <div className="text-sm font-medium text-ink-900 break-words">{line.name || 'Alternativa'}</div>
        <div className="text-[11px] text-ink-500 break-words">{material}</div>
      </button>
      <div className="flex items-center gap-2 ml-auto flex-shrink-0">
        <div className={`text-sm font-semibold tabular-nums text-ink-900 whitespace-nowrap ${dim}`}>
          {priceLabel}
        </div>
        <button
          type="button"
          onClick={onToggleEdit}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 rounded-md px-2 py-1 coarse:min-h-11 flex-shrink-0 transition-colors"
          title="Editar esta alternativa"
        >
          <Pencil size={12} className="opacity-80" aria-hidden /> Editar
        </button>
      </div>
    </li>
  );
}
