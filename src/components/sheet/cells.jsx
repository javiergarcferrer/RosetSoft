import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, TriangleAlert, X } from 'lucide-react';

// Shared primitives for the inline-editable "sheet" list pages
// (Profesionales, Clientes). One home so the two sheets can't drift on
// commit semantics: draft-while-focused (a live-query repaint can't clobber
// typing), commit on blur only when the value changed, revert on Escape,
// and `onCommit` may return false to reject the edit (the draft snaps back).
//
// The draft is OPTIMISTIC across the save round-trip: it re-syncs from the
// server value only when that value CHANGES while unfocused — never on the
// blur itself. Resetting on blur made the typed text flash back to the old
// value for the write+refetch window (~a second), which read as "my edit
// disappeared". A failed commit reverts explicitly instead.

// Borderless input that reads exactly like the cell text until focused —
// the "viewing IS editing" core of the sheet.
export const CELL_CLS = 'w-full bg-transparent text-sm text-ink-900 placeholder:text-ink-300 '
  + 'px-1 py-0.5 -mx-1 rounded-md border-0 focus:outline-none focus:bg-surface '
  + 'focus:ring-2 focus:ring-brand-400/70 focus:shadow-sm transition-shadow';

/** Move focus to the same column on another row (Enter / Shift+Enter). */
export function focusCell(row, col) {
  const el = document.querySelector(`[data-cell="${row}:${col}"]`);
  if (el) { el.focus(); el.select?.(); }
}

/** One spreadsheet cell; Enter/Shift+Enter hop rows within the column. */
export function Cell({ value, onCommit, row, col, type = 'text', inputMode, placeholder, align = '', label }) {
  const [draft, setDraft] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value ?? ''); }, [value]);

  async function commit() {
    focused.current = false;
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
      onFocus={(e) => { focused.current = true; e.target.select(); }}
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
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value ?? ''); }, [value]);
  return (
    <div className={className}>
      <span className="eyebrow-xs text-ink-400">{label}</span>
      <input
        type={type}
        inputMode={inputMode}
        className="mt-1 w-full rounded-lg border border-ink-100 bg-surface px-2.5 py-1.5 text-sm text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-400/70 transition-shadow"
        value={draft}
        placeholder={placeholder || '—'}
        aria-label={label}
        onFocus={(e) => { focused.current = true; e.target.select(); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={async () => {
          focused.current = false;
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

// ── Contact identity + status (Clientes / Profesionales) ────────────────────
// One source of truth for the per-row "where does this contact stand" read,
// so the avatar tint, the status chip and the two sheets can never disagree.
// Presentational only (label + Tailwind tones); no money math lives here — it
// reads the rollup the list VM already computed.
const STATUS_TONES = {
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  sky: 'bg-sky-50 text-sky-700 ring-sky-100',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
  muted: 'bg-ink-100 text-ink-500 ring-ink-200',
};

/**
 * The single salient pipeline status for a contact, derived from its rollup.
 * Clientes read by money (comprador → pipeline → cotizado → frío); the
 * Profesionales referral story is simpler (con ventas → activo → frío).
 * Returns { label, tone, cls } — `cls` is the ring+tint shared by chip+avatar.
 */
export function contactStatusInfo(rollup, kind = 'customer') {
  const r = rollup || {};
  let label;
  let tone;
  if (kind === 'professional') {
    if (r.acceptedTotal > 0) { label = 'Con ventas'; tone = 'emerald'; }
    else if (r.count > 0) { label = 'Activo'; tone = 'sky'; }
    else { label = 'Sin actividad'; tone = 'muted'; }
  } else {
    if (r.acceptedTotal > 0) { label = 'Comprador'; tone = 'emerald'; }
    else if (r.openCount > 0) { label = 'En pipeline'; tone = 'sky'; }
    else if (r.count > 0) { label = 'Cotizado'; tone = 'brand'; }
    else { label = 'Sin actividad'; tone = 'muted'; }
  }
  return { label, tone, cls: STATUS_TONES[tone] };
}

/** Glanceable pipeline-status pill (the "Estado" column / mobile sub-line). */
export function ContactStatusChip({ rollup, kind }) {
  const { label, cls } = contactStatusInfo(rollup, kind);
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
      {label}
    </span>
  );
}

/** Two-letter monogram from a contact name (first + last initial). */
function monogram(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Circular initials avatar, tinted by the contact's status so identity and
 * standing read together at a glance. Decorative (the name sits beside it),
 * so aria-hidden.
 */
export function ContactAvatar({ name, rollup, kind, size = 'md' }) {
  const { cls } = contactStatusInfo(rollup, kind);
  const dim = size === 'sm' ? 'h-7 w-7 text-[10px]' : 'h-8 w-8 text-[11px]';
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase tracking-tight ring-1 ring-inset ${cls} ${dim}`}
      aria-hidden
    >
      {monogram(name)}
    </span>
  );
}

/**
 * The Shopify-style summary band that sits above the search header: a quiet
 * rounded card with a few headline facts (count + money rollups). `stats` is
 * an array of { label, value, tone? } — the page passes the figures its VM
 * already summed so the band derives nothing.
 */
export function ListSummaryBand({ stats }) {
  return (
    <div className="card mb-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 px-4 py-3">
      {stats.map((s, i) => (
        <div key={i} className="flex items-baseline gap-1.5">
          <span className={`font-display text-lg font-semibold tabular-nums leading-none ${s.tone || 'text-ink-900'}`}>
            {s.value}
          </span>
          <span className="text-xs text-ink-500">{s.label}</span>
        </div>
      ))}
    </div>
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
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value ?? ''); }, [value]);
  return (
    <div>
      <span className="eyebrow-xs text-ink-400">{label}</span>
      <textarea
        rows={2}
        className="mt-1 w-full resize-y rounded-lg border border-ink-100 bg-surface px-2.5 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-400/70 transition-shadow"
        placeholder={placeholder}
        aria-label={name ? `${label} de ${name}` : label}
        value={draft}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={async () => {
          focused.current = false;
          if (String(draft) === String(value ?? '')) return;
          const ok = await onCommit(draft);
          if (ok === false) setDraft(value ?? '');
        }}
      />
    </div>
  );
}
