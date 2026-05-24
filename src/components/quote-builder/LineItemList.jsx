import { useState } from 'react';
import { Plus, Hash, Boxes, GitFork, PlusCircle } from 'lucide-react';
import QuoteLineItem from './QuoteLineItem.jsx';
import SectionDivider from './SectionDivider.jsx';
import { LINE_KIND_SECTION } from '../../lib/constants.js';
import { setSubtotal, alternativeSubtotal, groupRuns } from '../../lib/pricing.js';
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
export default function LineItemList({
  lines, quote, focusLineId,
  onChangeLine, onRemoveLine, onDuplicateLine, onReorder,
  onToggleOptional, onAddAlternative, onSelectAlternative,
  onSeparateFromSet, onUngroup, onJoinSet,
  onAddItem, onAddSection,
}) {
  // Pre-compute alternative-group sizes so each line knows the
  // "Alternativa N de M" position without re-scanning the list.
  const groupInfo = (() => {
    const map = new Map();
    const counts = new Map();
    for (const l of lines) {
      const g = l.alternativeGroup;
      if (!g) continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    const seen = new Map();
    for (const l of lines) {
      const g = l.alternativeGroup;
      if (!g) continue;
      const idx = (seen.get(g) || 0) + 1;
      seen.set(g, idx);
      map.set(l.id, { index: idx, total: counts.get(g) });
    }
    return map;
  })();

  // Same "Conjunto N de M" position map for sets.
  const setInfo = (() => {
    const map = new Map();
    const counts = new Map();
    for (const l of lines) {
      const g = l.setGroup;
      if (!g) continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    const seen = new Map();
    for (const l of lines) {
      const g = l.setGroup;
      if (!g) continue;
      const idx = (seen.get(g) || 0) + 1;
      seen.set(g, idx);
      map.set(l.id, { index: idx, total: counts.get(g) });
    }
    return map;
  })();

  const currency = quote?.currencyCode || 'USD';
  const rates = quote?.rates || { USD: 1 };
  const byId = new Map(lines.map((l) => [l.id, l]));

  // -------- drag-reorder --------
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);

  function onDragStart(e, id) {
    setDraggingId(id);
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch {}
  }
  function onDragEnd() {
    setDraggingId(null);
    setDropTargetId(null);
  }
  function onDragOver(e, id) {
    if (!draggingId || draggingId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetId(id);
  }
  function onDrop(e, id) {
    e.preventDefault();
    const srcId = draggingId;
    setDraggingId(null);
    setDropTargetId(null);
    if (!srcId || srcId === id) return;
    const srcIdx = lines.findIndex((l) => l.id === srcId);
    const dstIdx = lines.findIndex((l) => l.id === id);
    if (srcIdx === -1 || dstIdx === -1) return;
    // Drop indicator renders ABOVE the target row, so the dragged item lands
    // just before the target. After removing src, indices above the original
    // shift down by one — when dragging downward we subtract one from dst.
    const next = [...lines];
    const [moved] = next.splice(srcIdx, 1);
    const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
    next.splice(insertAt, 0, moved);
    onReorder(next.map((l) => l.id));
  }

  if (lines.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-ink-100 text-ink-500 mb-3">
          <Plus size={18} />
        </div>
        <div className="text-sm font-medium text-ink-900">Empieza tu cotización</div>
        <div className="text-xs text-ink-500 mt-1 max-w-sm mx-auto">
          Lee una fila de la lista de precios y pulsa <b>Agregar artículo</b>, o usa
          el palette de acciones para insertar uno reciente.
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button type="button" onClick={onAddItem} className="btn-primary">
            <Plus size={14} /> Agregar artículo
          </button>
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
    const isDragging = draggingId === l.id;
    const isDropTarget = dropTargetId === l.id && draggingId !== l.id;
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
        {isSection ? (
          <SectionDivider
            line={l}
            onChange={(patch) => onChangeLine(l.id, patch)}
            onRemove={() => onRemoveLine(l)}
            autoFocus={l.id === focusLineId}
            dragHandleProps={handleProps}
          />
        ) : (
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
    const footerValue = isSet
      ? setSubtotal(lines, run.groupId)
      : alternativeSubtotal(lines, run.groupId);

    return (
      <GroupCard
        key={`grp-${run.groupId}-${run.start}`}
        type={run.type}
        accent={accent}
        memberCount={members.length}
        footerLabel={isSet ? 'Total del conjunto' : 'Total'}
        footerValue={formatMoney(footerValue, currency, rates)}
      >
        <ul className="divide-y divide-ink-100">
          {members.map((l) => renderRow(l, { insideGroupCard: true }))}
        </ul>
      </GroupCard>
    );
  }

  return (
    <div className="group/list">
      <ul className="divide-y divide-ink-100">
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
        className="inline-flex items-center gap-1 rounded-full border border-ink-200 bg-white px-2.5 py-1 coarse:py-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-ink-400 shadow-sm transition-colors opacity-60 hover:opacity-100 hover:text-ink-700 hover:border-ink-400 focus:opacity-100 focus:text-ink-700 focus:border-ink-400 focus:outline-none coarse:opacity-100"
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
function GroupCard({ type, accent, memberCount, footerLabel, footerValue, children }) {
  const isSet = type === 'set';
  // Tailwind needs literal class names — branch rather than interpolate.
  const ring = isSet ? 'border-ink-300' : 'border-brand-300';
  const headBg = isSet ? 'bg-ink-50' : 'bg-brand-50/50';
  const footBg = isSet ? 'bg-ink-50/70' : 'bg-brand-50/40';
  const eyebrowColor = isSet ? 'text-ink-600' : 'text-brand-700';
  const Icon = isSet ? Boxes : GitFork;
  const eyebrow = isSet ? 'Conjunto' : 'Alternativas — elige una';
  return (
    // Inset card so the surrounding row dividers don't bleed into it.
    <div className="px-3 sm:px-4 py-3">
      <div className={`rounded-xl border-2 ${ring} overflow-hidden bg-white`}>
        <div className={`${headBg} px-4 py-2 flex items-center justify-between gap-2`}>
          <span className={`inline-flex items-center gap-1.5 eyebrow font-semibold tracking-[0.06em] ${eyebrowColor}`}>
            <Icon size={13} className="opacity-80" aria-hidden />
            {eyebrow}
          </span>
          <span className="eyebrow-xs font-medium tracking-wide text-ink-400 tabular-nums">
            {memberCount} {isSet ? 'piezas' : 'opciones'}
          </span>
        </div>
        {children}
        <div className={`${footBg} border-t-2 ${ring} px-4 py-2.5 flex items-center justify-between gap-2`}>
          <span className={`inline-flex items-center gap-1.5 eyebrow font-semibold tracking-[0.06em] ${eyebrowColor}`}>
            <Icon size={12} className="opacity-80" aria-hidden />
            {footerLabel}
          </span>
          <span className="text-sm font-semibold text-ink-900 tabular-nums">
            {footerValue}
          </span>
        </div>
      </div>
    </div>
  );
}
