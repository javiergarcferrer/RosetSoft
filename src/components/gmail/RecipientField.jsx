import { useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { isEmailAddress } from '../../core/crm/index.js';

/**
 * A Gmail-style recipient field — chips for committed addresses + a typeahead
 * over CRM contacts and past correspondents. Controlled: `value` is the array of
 * email strings, `onChange` replaces it. `suggest(needle, exclude)` returns
 * `[{ name, email, kind }]` (the View wires it to resolveEmailRecipients). Commit
 * a typed address with Enter / Tab / comma / semicolon, or by picking a
 * suggestion; Backspace on an empty input pops the last chip.
 */
export default function RecipientField({ label, value = [], onChange, suggest, autoFocus = false }) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const listId = useId();

  const suggestions = focused && text.trim() && suggest ? suggest(text.trim(), value) : [];
  const showList = suggestions.length > 0;

  const add = (email) => {
    const e = String(email || '').trim().replace(/[,;]\s*$/, '');
    if (!isEmailAddress(e)) return false;
    if (!value.some((v) => v.toLowerCase() === e.toLowerCase())) onChange([...value, e]);
    setText('');
    setActive(0);
    return true;
  };
  const removeAt = (i) => onChange(value.filter((_, idx) => idx !== i));

  const onKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';')) {
      if (showList && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault();
        add(suggestions[active]?.email);
        return;
      }
      if (text.trim()) { e.preventDefault(); add(text); }
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) { removeAt(value.length - 1); return; }
    if (e.key === 'ArrowDown' && showList) { e.preventDefault(); setActive((a) => Math.min(a + 1, suggestions.length - 1)); }
    if (e.key === 'ArrowUp' && showList) { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
  };

  return (
    <div className="flex items-start gap-2">
      <span className="w-12 shrink-0 pt-2 text-xs font-medium text-ink-400">{label}</span>
      <div className="relative min-w-0 flex-1">
        <div
          className="flex flex-wrap items-center gap-1 rounded-lg border border-ink-200 bg-surface px-1.5 py-1 focus-within:ring-2 focus-within:ring-ink-300"
          onClick={() => inputRef.current?.focus()}
        >
          {value.map((email, i) => (
            <span key={email} className="inline-flex max-w-full items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-700">
              <span className="truncate">{email}</span>
              <button type="button" onClick={() => removeAt(i)} className="shrink-0 text-ink-400 hover:text-ink-700" aria-label={`Quitar ${email}`}>
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            type="text"
            value={text}
            autoFocus={autoFocus}
            onChange={(e) => { setText(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); if (text.trim()) add(text); }}
            placeholder={value.length ? '' : 'nombre o correo…'}
            className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm focus:outline-none"
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            aria-autocomplete="list" aria-controls={listId}
          />
        </div>
        {showList && (
          <ul id={listId} className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-ink-200 bg-surface shadow-pop">
            {suggestions.map((s, i) => (
              <li key={s.email}>
                <button
                  type="button"
                  // onMouseDown (not click) so it fires before the input's blur.
                  onMouseDown={(e) => { e.preventDefault(); add(s.email); }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${i === active ? 'bg-ink-50' : 'hover:bg-ink-50'}`}
                >
                  <span className="min-w-0">
                    {s.name && <span className="font-medium text-ink-800">{s.name} </span>}
                    <span className="text-ink-500">{s.email}</span>
                  </span>
                  {s.kind !== 'contact' && (
                    <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
                      {s.kind === 'customer' ? 'Cliente' : 'Profesional'}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
