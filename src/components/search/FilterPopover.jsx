import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import Modal from '../Modal.jsx';
import Select from '../primitives/Select.jsx';
import useDismissable from './useDismissable.js';

/**
 * Render-time viewport check so we mount EXACTLY ONE filter surface — the
 * desktop popover OR the mobile sheet — never both. A CSS-only `sm:hidden`
 * wrapper can't do this here because <Modal> portals to <body>, escaping the
 * wrapper's hidden class: the sheet would leak onto desktop. Matching the
 * Tailwind `sm` breakpoint (640px) keeps the JS decision in lockstep with
 * the rest of the design system. SSR-safe default (false → sheet) is moot in
 * this client-only app but costs nothing.
 */
function useIsDesktop() {
  const query = '(min-width: 640px)';
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return matches;
}

/**
 * Secondary-filter surface — Shopify's "More filters" affordance. A single
 * "Filtros" trigger (SlidersHorizontal) opens a panel of declarative filter
 * controls (select / date-range / text). On a phone it's a bottom sheet
 * (reuses <Modal>, which is already sheet-on-mobile / dialog-on-desktop and
 * handles body-scroll-lock + Esc); on a pointer-fine viewport it's a small
 * anchored popover so the dealer keeps the list in view while refining.
 *
 * Presentational only: the parent owns `activeFilters` ({key: value}) and
 * does the filtering. This component edits a LOCAL draft of that object and
 * only commits on "Aplicar" — so a half-typed date range never thrashes the
 * list mid-edit, and "Cancelar" / dismiss discards cleanly. The trigger
 * shows a count badge of how many filters are currently active so the
 * affordance reads as "2 filtros aplicados" at a glance.
 *
 * The same <FilterFields> body renders in both the sheet and the popover so
 * the two surfaces can never drift. We branch only on the chrome.
 */
function activeCount(filters, activeFilters) {
  return (filters || []).reduce((n, f) => {
    const v = activeFilters?.[f.key];
    if (v == null || v === '') return n;
    if (f.type === 'date-range') {
      const { from, to } = v || {};
      return from || to ? n + 1 : n;
    }
    return n + 1;
  }, 0);
}

export default function FilterPopover({ filters, activeFilters, onFiltersChange }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(activeFilters || {});
  const wrapRef = useRef(null);
  const isDesktop = useIsDesktop();
  // The desktop popover dismisses on outside-click / Esc; the mobile sheet
  // has its own Esc + backdrop handling inside <Modal>. Only arm the
  // outside-click listener for the popover (the sheet has a backdrop), and
  // only while open.
  useDismissable(open && isDesktop, () => setOpen(false), wrapRef);

  if (!filters || filters.length === 0) return null;

  const count = activeCount(filters, activeFilters);

  // Re-seed the draft from the committed value every time we open, so a
  // previous "Cancelar" can't leave a stale draft behind.
  function openPanel() {
    setDraft(activeFilters || {});
    setOpen(true);
  }

  function setDraftValue(key, value) {
    setDraft((d) => {
      const next = { ...d };
      if (value == null || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function apply() {
    onFiltersChange(draft);
    setOpen(false);
  }

  function clear() {
    setDraft({});
  }

  const trigger = (
    <button
      type="button"
      onClick={() => (open ? setOpen(false) : openPanel())}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={`btn-ghost border bg-surface transition-colors ${
        count > 0
          ? 'border-brand-300 text-brand-700 hover:border-brand-400 hover:bg-brand-50'
          : 'border-ink-200'
      }`}
      title="Filtros"
    >
      <SlidersHorizontal size={14} />
      <span className="hidden sm:inline">Filtros</span>
      {count > 0 && (
        <span className="tabular-nums inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[11px] font-semibold text-white">
          {count}
        </span>
      )}
    </button>
  );

  return (
    <div ref={wrapRef} className="relative">
      {trigger}

      {/* Desktop: anchored popover next to the trigger. Mounted only when
          the viewport is ≥ sm AND open, so the body-portaled mobile sheet
          can never co-exist with it. */}
      {isDesktop && open && (
        <div
          role="dialog"
          aria-label="Filtros"
          className="absolute right-0 z-30 mt-1 w-[min(20rem,calc(100vw-1rem))] rounded-xl border border-ink-100 bg-surface p-4 shadow-pop"
        >
          <FilterFields filters={filters} draft={draft} setDraftValue={setDraftValue} />
          <PanelActions onClear={clear} onApply={apply} hasDraft={activeCount(filters, draft) > 0} />
        </div>
      )}

      {/* Mobile: bottom sheet via the shared Modal (portals to <body>; is
          sheet-on-mobile and handles Esc + scroll-lock for us). Mounted only
          below sm so it can't leak onto desktop. */}
      {!isDesktop && (
        <Modal open={open} onClose={() => setOpen(false)} title="Filtros" size="sm">
          <FilterFields filters={filters} draft={draft} setDraftValue={setDraftValue} />
          <div className="pt-2">
            <PanelActions onClear={clear} onApply={apply} hasDraft={activeCount(filters, draft) > 0} />
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * The declarative filter body shared by sheet + popover. One labelled block
 * per configured filter; the control is chosen by `type`:
 *   select      → native <Select> (platform picker on touch — best thumb UX)
 *   date-range  → two type="date" inputs (Desde / Hasta) emitting {from,to}
 *   text        → a plain text input
 */
function FilterFields({ filters, draft, setDraftValue }) {
  return (
    <div className="space-y-4">
      {filters.map((f) => (
        <div key={f.key}>
          <span className="label">{f.label}</span>
          {f.type === 'select' && (
            <Select
              value={draft[f.key] ?? ''}
              onChange={(v) => setDraftValue(f.key, v)}
              aria-label={f.label}
            >
              <option value="">{f.placeholder || 'Todos'}</option>
              {(f.options || []).map((o) => (
                <option key={String(o.value)} value={o.value}>{o.label}</option>
              ))}
            </Select>
          )}

          {f.type === 'date-range' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="block text-[10px] text-ink-400 mb-1">Desde</span>
                <input
                  type="date"
                  className="input"
                  aria-label={`${f.label} desde`}
                  value={draft[f.key]?.from || ''}
                  onChange={(e) => {
                    const from = e.target.value;
                    const to = draft[f.key]?.to || '';
                    setDraftValue(f.key, from || to ? { from, to } : '');
                  }}
                />
              </div>
              <div>
                <span className="block text-[10px] text-ink-400 mb-1">Hasta</span>
                <input
                  type="date"
                  className="input"
                  aria-label={`${f.label} hasta`}
                  value={draft[f.key]?.to || ''}
                  onChange={(e) => {
                    const to = e.target.value;
                    const from = draft[f.key]?.from || '';
                    setDraftValue(f.key, from || to ? { from, to } : '');
                  }}
                />
              </div>
            </div>
          )}

          {f.type === 'text' && (
            <input
              type="text"
              className="input"
              aria-label={f.label}
              placeholder={f.placeholder || ''}
              value={draft[f.key] || ''}
              onChange={(e) => setDraftValue(f.key, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function PanelActions({ onClear, onApply, hasDraft }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-2">
      <button
        type="button"
        onClick={onClear}
        disabled={!hasDraft}
        className="btn-ghost text-sm disabled:opacity-40"
      >
        Limpiar
      </button>
      <button type="button" onClick={onApply} className="btn-primary text-sm">
        Aplicar
      </button>
    </div>
  );
}
