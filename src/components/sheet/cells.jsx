import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, TriangleAlert, X, Loader2 } from 'lucide-react';
import { lookupRnc, cleanRnc, isValidRncOrCedula } from '../../lib/rncLookup.js';

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

// ── Monogram + contact-channel primitives ───────────────────────────────────
// Shared by the Profesionales and Clientes mobile cards so the two directories
// can't drift on their card chrome (same rationale as the Cell above).

// Curated monogram palette — the app's tint tiles, each with a dark-mode
// variant (index.css), so a colour-coded avatar stays theme-correct. A
// contact's tint is a stable hash of their name (below), giving the list a
// second, pre-attentive scanning dimension beyond the text.
const MONO_TINTS = ['tint-brand', 'tint-sky', 'tint-emerald', 'tint-rose', 'tint-ink'];

/**
 * Editorial monogram plate — the identity anchor of a mobile directory card.
 * Initials in the Söhne display cut on a soft tinted squircle; the tint is a
 * stable hash of the name so the same person always reads the same colour. An
 * amber corner badge flags missing contact data (the maintenance signal the
 * desktop row carries as ContactGapDot).
 */
export function Monogram({ name, rollup }) {
  const clean = String(name || '').trim();
  const initials = clean
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n.charAt(0).toUpperCase())
    .join('') || '?';
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  const tint = MONO_TINTS[h % MONO_TINTS.length];
  const missing = rollup?.incomplete
    ? [rollup.missingEmail ? 'correo' : null, rollup.missingPhone ? 'teléfono' : null]
        .filter(Boolean).join(' y ')
    : '';
  return (
    <div className="relative shrink-0">
      <span className={`flex h-11 w-11 items-center justify-center rounded-2xl font-display text-sm font-semibold ring-1 ring-inset ring-black/5 shadow-xs ${tint}`}>
        {initials}
      </span>
      {missing && (
        <span
          className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-amber-400 ring-2 ring-surface"
          role="img"
          title={`Faltan datos de contacto: ${missing}`}
          aria-label={`Faltan datos de contacto: ${missing}`}
        />
      )}
    </div>
  );
}

/** A contact channel row in a card footer — an icon labels the inline Cell so
 *  an empty field reads as "tap to add", never as orphaned grey text. */
export function ContactCell({ icon: Icon, value, ...cellProps }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <Icon size={14} aria-hidden className={`shrink-0 ${value ? 'text-ink-400' : 'text-ink-300'}`} />
      <Cell value={value} align="!text-ink-700" {...cellProps} />
    </div>
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
 * RNC / cédula field with DGII auto-fill, for the expanded-panel grid. Same
 * draft/commit chrome as PanelField, plus: as soon as a COMPLETE rnc/cédula is
 * typed (or pasted), it auto-looks-up the taxpayer in the DGII registry —
 * ~500ms after the digits settle, no button and no need to blur — and writes
 * the resolved name into the Empresa field via `onResolveCompany` (razón
 * social, falling back to nombre comercial). A spinner shows while it queries;
 * a tiny status line echoes the match (or "no encontrado"). Shared by the
 * Clientes and Profesionales panels so both auto-fill identically.
 *
 *   value             — the stored RNC/cédula.
 *   onCommitRnc(v)    — persists the id; may return false to reject (revert).
 *   onResolveCompany(name) — persists the looked-up company name.
 */
export function RncPanelField({ value, onCommitRnc, onResolveCompany, className = '' }) {
  const [draft, setDraft] = useState(value ?? '');
  const focused = useRef(false);
  const [looking, setLooking] = useState(false);
  const [status, setStatus] = useState('');
  // The id we've already resolved from — dedupes the debounce-vs-blur double
  // fire and stops a re-render from re-querying the same number.
  const resolved = useRef('');
  useEffect(() => { if (!focused.current) setDraft(value ?? ''); }, [value]);

  // Persist the id (when it changed) then DGII-fill Empresa from the registry.
  // Guarded so the auto-fire and the blur never query the same id twice.
  async function resolve(clean) {
    if (!isValidRncOrCedula(clean) || resolved.current === clean) return;
    resolved.current = clean;
    if (clean !== String(value ?? '')) {
      const ok = await onCommitRnc(clean);
      if (ok === false) { resolved.current = ''; setDraft(value ?? ''); return; }
    }
    setLooking(true);
    try {
      const r = await lookupRnc(clean);
      if (r.found) {
        const name = r.commercialName || r.name || '';
        if (name) await onResolveCompany(name);
        setStatus(`✓ ${r.name}${r.status ? ` · ${r.status}` : ''}`);
      } else {
        setStatus(r.message || 'No encontrado.');
      }
    } catch {
      resolved.current = '';   // transient failure — let a retry through
      setStatus('No se pudo consultar el RNC.');
    } finally {
      setLooking(false);
    }
  }

  // Auto-fill: ~500ms after the digits settle on a COMPLETE, NEW rnc/cédula,
  // look it up automatically (only while the user is editing — never on an
  // external value change). This is what "automatically fills" means: no
  // button, no need to blur.
  useEffect(() => {
    const clean = cleanRnc(draft);
    if (!focused.current || !isValidRncOrCedula(clean) || clean === resolved.current) return;
    const t = setTimeout(() => resolve(clean), 500);
    return () => clearTimeout(t);
    // resolve closes over the latest props each render; gate is `draft`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Blur: resolve a valid id immediately (no debounce wait); otherwise just
  // persist whatever partial was typed, same as any panel field.
  async function commit() {
    focused.current = false;
    const clean = cleanRnc(draft);
    if (clean !== draft) setDraft(clean);
    if (isValidRncOrCedula(clean)) { resolve(clean); return; }
    if (clean !== String(value ?? '')) {
      const ok = await onCommitRnc(clean);
      if (ok === false) setDraft(value ?? '');
    }
  }

  return (
    <div className={className}>
      <span className="eyebrow-xs text-ink-400">RNC</span>
      <div className="relative mt-1">
        <input
          inputMode="numeric"
          className="w-full rounded-lg border border-ink-100 bg-surface px-2.5 py-1.5 pr-8 text-sm text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-400/70 transition-shadow"
          value={draft}
          placeholder="—"
          aria-label="RNC"
          enterKeyHint="search"
          onFocus={(e) => { focused.current = true; e.target.select(); }}
          onChange={(e) => { setDraft(e.target.value); if (status) setStatus(''); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === 'Escape') {
              const el = e.currentTarget;
              setDraft(value ?? ''); setStatus('');
              requestAnimationFrame(() => el.blur());
            }
          }}
        />
        {looking && (
          <Loader2 size={14} aria-hidden className="animate-spin text-ink-400 absolute right-2.5 top-1/2 -translate-y-1/2" />
        )}
      </div>
      {status && (
        <p className={`mt-1 text-[11px] leading-tight ${status.startsWith('✓') ? 'text-emerald-600' : 'text-ink-400'}`}>
          {status}
        </p>
      )}
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
