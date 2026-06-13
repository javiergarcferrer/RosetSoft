import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, CirclePlus, X } from 'lucide-react';
import Modal from '../Modal.jsx';
import { DebouncedInput } from '../DebouncedInput.jsx';
import useDismissable from './useDismissable.js';

/**
 * FilterBar — Shopify-admin-style secondary filters. One pill PER filter,
 * always visible, each opening its own small popover (desktop) or bottom
 * sheet (mobile) with exactly that control. Every change applies
 * IMMEDIATELY — there is no Aplicar/Cancelar round-trip, the list reacts as
 * you pick (the Odoo/Shopify interaction the dealers know from those
 * admins). An applied pill shows `Label: value` with its own ×; "Limpiar
 * todo" appears once anything is active.
 *
 * Same contract as the old single-popover surface (the parent owns
 * `activeFilters` and does the filtering): filters config in,
 * onFiltersChange(next) out — which is what lets every list page upgrade by
 * just rendering this instead.
 */

// Mount exactly ONE surface per pill — popover ≥sm, sheet below. A CSS-only
// `sm:hidden` can't do it because <Modal> portals to <body>.
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

function isActive(filter, value) {
  if (value == null || value === '') return false;
  if (filter.type === 'date-range') {
    const { from, to } = value || {};
    return !!(from || to);
  }
  return true;
}

// Value → human label for the applied pill (select resolves the option's
// label; date-range renders Desde/Hasta; text shows the raw string).
function describeValue(filter, value) {
  if (!isActive(filter, value)) return null;
  if (filter.type === 'select') {
    const opt = (filter.options || []).find((o) => String(o.value) === String(value));
    return opt ? opt.label : String(value);
  }
  if (filter.type === 'date-range') {
    const { from, to } = value || {};
    if (from && to) return `${from} – ${to}`;
    if (from) return `Desde ${from}`;
    return `Hasta ${to}`;
  }
  return String(value);
}

export default function FilterBar({ filters, activeFilters = {}, onFiltersChange }) {
  if (!filters || filters.length === 0) return null;

  function setValue(key, value) {
    const next = { ...activeFilters };
    if (value == null || value === '') delete next[key];
    else next[key] = value;
    onFiltersChange(next);
  }

  const anyActive = filters.some((f) => isActive(f, activeFilters[f.key]));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filters.map((f) => (
        <FilterPill
          key={f.key}
          filter={f}
          value={activeFilters[f.key]}
          onChange={(v) => setValue(f.key, v)}
        />
      ))}
      {anyActive && (
        <button
          type="button"
          onClick={() => onFiltersChange({})}
          className="text-xs font-medium text-ink-400 underline-offset-2 transition-colors hover:text-ink-600 hover:underline active:scale-[0.97] min-h-[2.25rem] coarse:min-h-[2.75rem] inline-flex items-center px-1"
        >
          Limpiar todo
        </button>
      )}
    </div>
  );
}

function FilterPill({ filter, value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const isDesktop = useIsDesktop();
  useDismissable(open && isDesktop, () => setOpen(false), wrapRef);

  const active = isActive(filter, value);
  const valueText = describeValue(filter, value);

  // Select pills close on pick (one tap, done). Date/text pills stay open
  // while the user composes the value; changes are still applied live.
  function commit(v, { close = false } = {}) {
    onChange(v);
    if (close) setOpen(false);
  }

  const body = (
    <FilterControl
      filter={filter}
      value={value}
      onCommit={commit}
      onDone={() => setOpen(false)}
      isDesktop={isDesktop}
    />
  );

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={`inline-flex items-stretch rounded-full text-xs transition-colors ${
          active
            ? 'border border-brand-200 bg-brand-50 text-brand-700 shadow-xs ring-1 ring-inset ring-black/5'
            : 'border border-dashed border-ink-300 text-ink-500 hover:border-ink-400 hover:text-ink-700'
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`inline-flex items-center gap-1 py-1.5 min-h-[2rem] coarse:min-h-[2.5rem] ${active ? 'pl-2.5 pr-1' : 'px-2.5'}`}
        >
          {!active && <CirclePlus size={12} className="text-ink-400" aria-hidden />}
          <span className={active ? 'text-brand-400 font-normal' : 'font-medium'}>
            {filter.label}{active ? ':' : ''}
          </span>
          {active && <span className="font-semibold text-brand-800">{valueText}</span>}
          {!active && <ChevronDown size={12} className="text-ink-400" aria-hidden />}
        </button>
        {active && (
          <button
            type="button"
            onClick={() => commit('', { close: false })}
            aria-label={`Quitar filtro ${filter.label}`}
            className="inline-flex w-6 coarse:w-8 items-center justify-center rounded-r-full text-brand-400 transition-colors hover:bg-brand-100 hover:text-brand-700 active:scale-[0.96]"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {isDesktop && open && (
        <div
          role="dialog"
          aria-label={filter.label}
          className="absolute left-0 z-30 mt-1 w-[min(17rem,calc(100vw-1rem))] rounded-xl border border-ink-100 bg-surface shadow-pop"
        >
          {body}
        </div>
      )}
      {!isDesktop && (
        <Modal open={open} onClose={() => setOpen(false)} title={filter.label} size="sm">
          {body}
        </Modal>
      )}
    </div>
  );
}

/** The single control inside a pill's popover/sheet, chosen by type. */
function FilterControl({ filter, value, onCommit, onDone, isDesktop }) {
  if (filter.type === 'select') {
    return (
      <div className="py-1.5 max-h-72 overflow-y-auto" role="listbox" aria-label={filter.label}>
        <SelectOption
          label={filter.placeholder || 'Todos'}
          selected={value == null || value === ''}
          onPick={() => onCommit('', { close: true })}
        />
        {(filter.options || []).map((o) => (
          <SelectOption
            key={String(o.value)}
            label={o.label}
            selected={String(value ?? '') === String(o.value)}
            onPick={() => onCommit(o.value, { close: true })}
          />
        ))}
      </div>
    );
  }

  if (filter.type === 'date-range') {
    const range = value || {};
    const setPart = (part, v) => {
      const next = { ...range, [part]: v };
      onCommit(next.from || next.to ? next : '');
    };
    return (
      <div className="p-3 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="block text-[10px] text-ink-400 mb-1">Desde</span>
            <input
              type="date"
              className="input"
              aria-label={`${filter.label} desde`}
              value={range.from || ''}
              onChange={(e) => setPart('from', e.target.value)}
            />
          </div>
          <div>
            <span className="block text-[10px] text-ink-400 mb-1">Hasta</span>
            <input
              type="date"
              className="input"
              aria-label={`${filter.label} hasta`}
              value={range.to || ''}
              onChange={(e) => setPart('to', e.target.value)}
            />
          </div>
        </div>
        <DoneRow onDone={onDone} isDesktop={isDesktop} />
      </div>
    );
  }

  // text
  return (
    <div className="p-3 space-y-2">
      <DebouncedInput
        className="input"
        value={value || ''}
        onCommit={(v) => onCommit(v)}
        delay={250}
        placeholder={filter.placeholder || ''}
        aria-label={filter.label}
      />
      <DoneRow onDone={onDone} isDesktop={isDesktop} />
    </div>
  );
}

function SelectOption({ label, selected, onPick }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={`flex w-full items-center gap-2 px-3 py-2 coarse:py-2.5 text-left text-sm transition-colors active:scale-[0.99] ${
        selected
          ? 'bg-brand-50 font-medium text-brand-700 hover:bg-brand-100'
          : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900 active:bg-ink-100'
      }`}
    >
      {selected ? <Check size={14} className="text-brand-600 shrink-0" /> : <span className="w-3.5 shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
    </button>
  );
}

// Changes already applied live — this row only dismisses the surface. The
// mobile sheet needs it (no outside-click); the desktop popover gets a
// quieter version for keyboard users.
function DoneRow({ onDone, isDesktop }) {
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onDone}
        className={isDesktop ? 'btn-ghost text-xs' : 'btn-primary text-sm w-full justify-center'}
      >
        Listo
      </button>
    </div>
  );
}
