import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, X, Tag } from 'lucide-react';
import Modal from '../Modal.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';

/**
 * Modal picker for a line item's `family` (AMÉDÉE / TOGO / TOGO ULTRA / …).
 *
 * Before this, the family was a hidden text field inside QuoteLineItem's
 * "Más detalles" disclosure: to set it you had to expand the row, scroll
 * past the catalog group, type the exact family name, and only then did
 * the chip at the top of the row populate. The dealer's reaction was
 * direct: "I don't like that I have to write family name there for it to
 * show up above. That's stupid." Fair.
 *
 * This picker collapses the workflow to one tap on the chip itself.
 * Behavior mirrors the existing CustomerPicker / ProfessionalPicker:
 *
 *   - Search input autofocuses on open.
 *   - List below shows every distinct family already used across the
 *     team's quotes, sorted by how often it's been used so the most
 *     common ones surface first. Source: a direct scan of every quote
 *     line's `family` field — NOT a reference/name-keyed dedupe, which
 *     drops any line lacking a reference/name and so silently hid families
 *     created on a still-unnamed line (the "created family doesn't come
 *     back" bug). Here a family counts the moment any line carries it.
 *   - When the typed query doesn't exactly match an existing family, a
 *     "Crear familia: 'XYZ'" row appears at the top — picking it sets
 *     the line's family to the new string. No separate families table
 *     is created; the next time the dealer opens this picker, the new
 *     family appears in the list automatically because a quote line
 *     now references it.
 *   - "Quitar familia" footer when the line currently has one — clears
 *     the field so the chip falls back to its "Sin familia" placeholder.
 *
 * Keyboard: ↑/↓ to move, Enter to pick, Esc to close.
 *
 * The picker is intentionally lean — no avatar art, no usage-count
 * badge cluttering the row. The family is just a short uppercase
 * string; the visual register is a tag, not a person.
 */
export default function FamilyPicker({ open, onClose, onSelect, currentFamily }) {
  const [q, setQ] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);

  // Build a deduped, frequency-sorted list of family strings straight from
  // every quote line that carries one. Comparison is case-insensitive but
  // we keep the first casing seen so "AMÉDÉE" doesn't become "amédée" on
  // re-pick. Counting raw line occurrences (not deduped suggestions) means
  // a family shows up the instant any line references it — including a line
  // that has no name/reference yet.
  const families = useMemo(() => {
    const byKey = new Map();
    for (const l of allLines) {
      const raw = (l.family || '').trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      const prev = byKey.get(key);
      if (!prev) byKey.set(key, { label: raw, useCount: 1 });
      else prev.useCount += 1;
    }
    return [...byKey.values()].sort((a, b) => b.useCount - a.useCount);
  }, [allLines]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActiveIdx(0);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return families.slice(0, 50);
    return families
      .filter((f) => f.label.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [q, families]);

  const exactMatch = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return false;
    return families.some((f) => f.label.toLowerCase() === needle);
  }, [q, families]);

  const showCreate = q.trim().length > 0 && !exactMatch;
  const totalRows = filtered.length + (showCreate ? 1 : 0);

  function commit(label) {
    const value = (label || '').trim();
    onSelect(value || null);
    onClose();
  }

  function pickAtIdx(i) {
    if (showCreate && i === 0) return commit(q);
    const f = filtered[i - (showCreate ? 1 : 0)];
    if (!f) return;
    commit(f.label);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(totalRows - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickAtIdx(activeIdx);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Familia"
      size="sm"
      footer={
        currentFamily ? (
          <button
            type="button"
            onClick={() => commit('')}
            className="btn-ghost text-ink-500 hover:text-red-600"
          >
            <X size={14} /> Quitar familia
          </button>
        ) : null
      }
    >
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value.toUpperCase()); setActiveIdx(0); }}
          onKeyDown={onKeyDown}
          className="input pl-9 uppercase tracking-wide"
          placeholder="AMÉDÉE, TOGO, MULTY…"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {q && (
          <button
            type="button"
            onClick={() => { setQ(''); inputRef.current?.focus(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1"
            aria-label="Limpiar"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="max-h-[60vh] overflow-y-auto -mx-1">
        {showCreate && (
          <button
            type="button"
            onMouseEnter={() => setActiveIdx(0)}
            onClick={() => commit(q)}
            className={`w-full text-left rounded-md px-3 py-2.5 mx-1 mb-1 flex items-center gap-2.5 transition-colors ${
              activeIdx === 0 ? 'bg-brand-50 text-brand-900' : 'hover:bg-ink-50'
            }`}
          >
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex-shrink-0">
              <Plus size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <div className="text-sm">
                Crear familia: <b className="uppercase">&ldquo;{q.trim()}&rdquo;</b>
              </div>
              <div className="text-[11px] text-ink-500">
                Disponible al instante para esta y para futuras cotizaciones.
              </div>
            </span>
          </button>
        )}

        {filtered.length === 0 && !showCreate ? (
          <div className="px-3 py-10 text-center text-sm text-ink-500">
            Aún no hay familias. Escribe una para crearla.
          </div>
        ) : (
          filtered.map((f, i) => {
            const idx = i + (showCreate ? 1 : 0);
            const isActive = activeIdx === idx;
            const isCurrent =
              currentFamily && currentFamily.toLowerCase() === f.label.toLowerCase();
            return (
              <button
                key={f.label}
                type="button"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pickAtIdx(idx)}
                className={`w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 min-h-[44px] flex items-center gap-2.5 transition-colors ${
                  isActive ? 'bg-ink-100' : 'hover:bg-ink-50'
                } ${isCurrent ? 'ring-1 ring-inset ring-brand-300' : ''}`}
              >
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-brand-50 text-brand-700 flex-shrink-0">
                  <Tag size={12} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold uppercase tracking-wide text-ink-900 truncate">
                    {f.label}
                    {isCurrent && <span className="ml-1.5 text-[10px] text-brand-700 font-medium normal-case tracking-normal">· actual</span>}
                  </div>
                </div>
                <span className="text-[11px] text-ink-500 tabular-nums whitespace-nowrap flex-shrink-0">
                  {f.useCount === 1 ? 'usada 1 vez' : `usada ${f.useCount} veces`}
                </span>
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
