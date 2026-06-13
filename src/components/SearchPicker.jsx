import { useMemo, useRef, useState } from 'react';
import { Plus, Check } from 'lucide-react';

/**
 * SearchPicker — a keyboard-first typeahead combobox that replaces the giant
 * `<select>` on high-volume entry forms (pick an inventory item among
 * hundreds without scrolling). Type to filter by label or sublabel, navigate
 * with ↑/↓, pick with Enter; with `allowFreeText` an unmatched query commits
 * as free text (e.g. "create this article on save") on Enter or blur.
 *
 * Dumb on purpose: options come in as `{ id, label, sublabel? }`, the parent
 * owns the selection (`value` = picked id, `text` = free-text fallback shown
 * when nothing is picked) and hears `onPick(option)` / `onFreeText(text)`.
 */
export default function SearchPicker({
  options,
  value,
  text = '',
  onPick,
  allowFreeText = false,
  onFreeText,
  placeholder,
  freeTextLabel = 'Usar',
  className = '',
  inputClassName = 'input',
  inputProps = {},
}) {
  const [query, setQuery] = useState(null); // null = closed/at-rest, string = editing
  const [hi, setHi] = useState(0);
  const listRef = useRef(null);

  const selected = useMemo(() => (value ? options.find((o) => o.id === value) || null : null), [options, value]);
  const display = query != null ? query : (selected?.label || text || '');
  const q = (query || '').trim().toLowerCase();

  const matches = useMemo(() => {
    if (query == null) return [];
    const scored = [];
    for (const o of options) {
      const label = (o.label || '').toLowerCase();
      const sub = (o.sublabel || '').toLowerCase();
      if (!q) { scored.push([1, o]); continue; }
      if (label.startsWith(q) || sub.startsWith(q)) scored.push([0, o]);
      else if (label.includes(q) || sub.includes(q)) scored.push([1, o]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    return scored.slice(0, 8).map(([, o]) => o);
  }, [options, query, q]);

  const exact = q && matches.some((o) => (o.label || '').toLowerCase() === q);
  const freeRow = allowFreeText && !!q && !exact;
  const rowCount = matches.length + (freeRow ? 1 : 0);
  const open = query != null && rowCount > 0;

  function commitPick(opt) {
    onPick?.(opt);
    setQuery(null);
  }
  function commitFree(t) {
    const v = (t || '').trim();
    if (v) onFreeText?.(v);
    setQuery(null);
  }
  function close() { setQuery(null); }

  function onKeyDown(e) {
    if (query == null && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      // Reopen the list from at-rest without losing the current value.
      if (e.key === 'ArrowDown') { e.preventDefault(); setQuery(''); setHi(0); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setHi((i) => Math.min(i + 1, rowCount - 1)); scrollTo(hi + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); scrollTo(hi - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hi < matches.length && matches[hi]) commitPick(matches[hi]);
      else if (freeRow) commitFree(query);
      else if (allowFreeText) commitFree(query);
      else close();
    } else if (e.key === 'Escape') {
      e.preventDefault(); close();
    } else if (e.key === 'Tab') {
      if (allowFreeText && q && !exact) commitFree(query);
      else close();
    }
  }

  function scrollTo(i) {
    const el = listRef.current?.children?.[Math.max(0, Math.min(i, rowCount - 1))];
    el?.scrollIntoView?.({ block: 'nearest' });
  }

  function onBlur() {
    if (query == null) return;
    if (allowFreeText && q && !exact) commitFree(query);
    else close();
  }

  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={display}
        placeholder={placeholder}
        className={inputClassName}
        onFocus={(e) => { setQuery(''); setHi(0); e.target.select?.(); }}
        onChange={(e) => { setQuery(e.target.value); setHi(0); }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        {...inputProps}
      />
      {open && (
        <ul
          ref={listRef}
          className="dropdown-pop absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-auto overscroll-contain rounded-xl border border-ink-200 bg-surface shadow-pop py-1 text-sm"
        >
          {matches.map((o, i) => (
            <li key={o.id}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => { e.preventDefault(); commitPick(o); }}
                onMouseEnter={() => setHi(i)}
                className={`w-full text-left px-3 py-1.5 min-h-8 coarse:min-h-11 flex items-center gap-2 transition-colors ${i === hi ? 'bg-ink-50' : ''}`}
              >
                {o.id === value ? <Check size={13} className="shrink-0 text-emerald-600" /> : <span className="w-[13px] shrink-0" />}
                <span className="min-w-0 flex-1 break-words">{o.label}</span>
                {o.sublabel && <span className="shrink-0 text-xs text-ink-400 font-mono">{o.sublabel}</span>}
              </button>
            </li>
          ))}
          {freeRow && (
            <li>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => { e.preventDefault(); commitFree(query); }}
                onMouseEnter={() => setHi(matches.length)}
                className={`w-full text-left px-3 py-1.5 min-h-8 coarse:min-h-11 flex items-center gap-2 text-amber-700 transition-colors ${hi === matches.length ? 'bg-amber-50' : ''}`}
              >
                <Plus size={13} className="shrink-0" />
                <span className="min-w-0 break-words">{freeTextLabel} «{query.trim()}»</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
