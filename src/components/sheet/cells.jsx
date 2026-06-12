import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, TriangleAlert, X } from 'lucide-react';

// Shared primitives for the inline-editable "sheet" list pages
// (Profesionales, Clientes). One home so the two sheets can't drift on
// commit semantics: draft-while-focused (a live-query repaint can't clobber
// typing), commit on blur only when the value changed, revert on Escape,
// and `onCommit` may return false to reject the edit (the draft snaps back).

// Borderless input that reads exactly like the cell text until focused —
// the "viewing IS editing" core of the sheet.
export const CELL_CLS = 'w-full bg-transparent text-sm text-ink-900 placeholder:text-ink-300 '
  + 'px-1 py-0.5 -mx-1 rounded-md border-0 focus:outline-none focus:bg-white '
  + 'focus:ring-2 focus:ring-brand-400/70 focus:shadow-sm transition-shadow';

/** Move focus to the same column on another row (Enter / Shift+Enter). */
export function focusCell(row, col) {
  const el = document.querySelector(`[data-cell="${row}:${col}"]`);
  if (el) { el.focus(); el.select?.(); }
}

/** One spreadsheet cell; Enter/Shift+Enter hop rows within the column. */
export function Cell({ value, onCommit, row, col, type = 'text', inputMode, placeholder, align = '', label }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(value ?? ''); }, [value, focused]);

  async function commit() {
    setFocused(false);
    if (String(draft) === String(value ?? '')) return;
    const ok = await onCommit(draft);
    if (ok === false) setDraft(value ?? '');
  }

  return (
    <input
      data-cell={row != null ? `${row}:${col}` : undefined}
      type={type}
      inputMode={inputMode}
      className={`${CELL_CLS} ${align}`}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onFocus={(e) => { setFocused(true); e.target.select(); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const next = row + (e.shiftKey ? -1 : 1);
          e.currentTarget.blur();
          if (row != null) focusCell(next, col);
        } else if (e.key === 'Escape') {
          const el = e.currentTarget;
          setDraft(value ?? '');
          requestAnimationFrame(() => el.blur());
        }
      }}
    />
  );
}

/**
 * Labeled bordered input for the expanded-panel field grid (the record's
 * secondary fields — RNC, dirección, provincia…). Same draft/commit
 * semantics as a Cell, form-field chrome because the panel reads as the
 * full record, not a sheet row.
 */
export function PanelField({ label, value, onCommit, type = 'text', inputMode, placeholder, className = '' }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(value ?? ''); }, [value, focused]);
  return (
    <div className={className}>
      <span className="eyebrow-xs text-ink-400">{label}</span>
      <input
        type={type}
        inputMode={inputMode}
        className="mt-1 w-full rounded-lg border border-ink-100 bg-white px-2.5 py-1.5 text-sm text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-400/70 transition-shadow"
        value={draft}
        placeholder={placeholder || '—'}
        aria-label={label}
        onFocus={(e) => { setFocused(true); e.target.select(); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={async () => {
          setFocused(false);
          if (String(draft) === String(value ?? '')) return;
          const ok = await onCommit(draft);
          if (ok === false) setDraft(value ?? '');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') {
            const el = e.currentTarget;
            setDraft(value ?? '');
            requestAnimationFrame(() => el.blur());
          }
        }}
      />
    </div>
  );
}

/**
 * Sortable column header. Clicking an inactive column sorts by it (text
 * columns ascending, numeric descending — "biggest first" is what you want
 * from a money/count column); clicking the active one flips direction.
 * Shares the SAME sort state as the SortMenu in the search header, so the
 * two affordances can never disagree.
 */
export function SortableTh({ label, sortKey, sort, onSort, numeric = false, className = '' }) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      className={className}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(active
          ? { key: sortKey, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key: sortKey, dir: numeric ? 'desc' : 'asc' })}
        className={`group/th inline-flex items-center gap-1 transition-colors hover:text-ink-900 ${
          numeric ? 'w-full justify-end' : ''
        } ${active ? 'text-ink-900' : ''}`}
        title={`Ordenar por ${label}`}
      >
        {label}
        <Icon
          size={11}
          className={active ? 'text-brand-600' : 'text-ink-200 group-hover/th:text-ink-400 transition-colors'}
          aria-hidden
        />
      </button>
    </th>
  );
}

/** Amber dot the maintenance views key on: this row is missing contact data. */
export function ContactGapDot({ rollup }) {
  if (!rollup?.incomplete) return null;
  const missing = [
    rollup.missingEmail ? 'correo' : null,
    rollup.missingPhone ? 'teléfono' : null,
  ].filter(Boolean).join(' y ');
  return (
    <span
      className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0"
      title={`Faltan datos de contacto: ${missing}`}
      role="img"
      aria-label={`Faltan datos de contacto: ${missing}`}
    />
  );
}

/**
 * Failed-write banner. A sheet cell that can't save reverts its draft — but
 * a revert alone reads as "the app ate my edit". The page catches the DB
 * error into one visible strip so a schema/permission problem is loud
 * instead of silently undoing the dealer's work.
 */
export function SheetErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="flex-1 min-w-0">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Cerrar aviso"
        className="shrink-0 rounded p-0.5 text-red-400 transition-colors hover:bg-red-100 hover:text-red-700"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Multiline sibling of PanelField — the notes editor in the panel. */
export function PanelTextArea({ label, value, onCommit, placeholder, name }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(value ?? ''); }, [value, focused]);
  return (
    <div>
      <span className="eyebrow-xs text-ink-400">{label}</span>
      <textarea
        rows={2}
        className="mt-1 w-full resize-y rounded-lg border border-ink-100 bg-white px-2.5 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-400/70 transition-shadow"
        placeholder={placeholder}
        aria-label={name ? `${label} de ${name}` : label}
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          if (String(draft) !== String(value ?? '')) onCommit(draft);
        }}
      />
    </div>
  );
}
