import { useState } from 'react';
import { Plus, Hash } from 'lucide-react';
import QuoteLineItem from './QuoteLineItem.jsx';
import SectionDivider from './SectionDivider.jsx';
import { LINE_KIND_SECTION } from '../../lib/constants.js';

/**
 * Renders the ordered list of quote lines (mixed items + sections) and owns
 * the drag-reorder interaction.
 *
 * Drag-reorder:
 *   - HTML5 drag-and-drop (desktop only; mobile users get the same effect by
 *     adding a new line where they want it and deleting the old one — the
 *     small-screen drag UX isn't worth the complexity).
 *   - Drop indicator: thin brand-color bar above the row being hovered.
 *   - Sort order is renormalised after a drop (0..N-1) so we never end up
 *     with gappy / colliding values, even across multiple reorders.
 */
export default function LineItemList({
  lines, quote, focusLineId,
  onChangeLine, onRemoveLine, onDuplicateLine, onReorder,
  onToggleOptional, onAddAlternative, onSelectAlternative,
  onAddItem, onAddSection,
}) {
  // Pre-compute alternative-group sizes so each line knows the
  // "Alternativa N de M" position without re-scanning the list. The
  // map is keyed by alternative_group string and carries the
  // 1-based index of each line in its group + the group's total
  // size. Computed once per render; cheap for any realistic quote.
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
    // The drop indicator is rendered ABOVE the target row, so the dragged
    // item should land just before the target. Splice semantics: after
    // removing src, every index above the original src has shifted down
    // by one — so when dragging downward we subtract one from dst.
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

  return (
    <ul className="divide-y divide-ink-100">
      {lines.map((l) => {
        const isSection = l.kind === LINE_KIND_SECTION;
        const isDragging = draggingId === l.id;
        const isDropTarget = dropTargetId === l.id && draggingId !== l.id;
        const handleProps = {
          draggable: true,
          onDragStart: (e) => onDragStart(e, l.id),
          onDragEnd,
          'data-dragging': isDragging ? 'true' : 'false',
        };
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
                groupInfo={groupInfo.get(l.id)}
                autoFocus={l.id === focusLineId}
                dragHandleProps={handleProps}
              />
            )}
          </div>
        );
      })}
    </ul>
  );
}
