import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, X, UserX } from 'lucide-react';
import Modal from '../Modal.jsx';
import CustomerModal from '../CustomerModal.jsx';
import { db, newId } from '../../db/database.js';

/**
 * Modal customer picker with inline create.
 *
 *   - Type to filter.
 *   - Pick a result with click or Enter.
 *   - When the query matches no exact result, an inline "Crear: 'XYZ'" row
 *     appears at the top. Clicking it (or Enter) mints a name-only customer
 *     and assigns them in one tap; the "Con detalles" button opens the full
 *     customer form (prefilled with the typed name) so phone / email /
 *     company can be captured without leaving the quote — on save the new
 *     customer is auto-assigned.
 *   - "Quitar cliente" at the bottom unassigns.
 */
export default function CustomerPicker({ open, onClose, onSelect, customers, profileId, currentId }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const [activeIdx, setActiveIdx] = useState(0);
  // When set, the full customer form is open on top of the picker, prefilled
  // with this draft ({ name, key }). Saving it assigns the new customer. The
  // bumping `key` forces a fresh CustomerModal mount on each open — without
  // it, a second "Con detalles" (another id-less draft) would reuse the
  // first draft's stale field values.
  const [detailDraft, setDetailDraft] = useState(null);
  const detailKeyRef = useRef(0);

  function openDetail() {
    detailKeyRef.current += 1;
    setDetailDraft({ name: q.trim(), key: detailKeyRef.current });
  }

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActiveIdx(0);
    setDetailDraft(null);
    // Autofocus after the modal mounts.
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return customers.slice(0, 50);
    return customers
      .filter((c) => (
        (c.name || '').toLowerCase().includes(needle) ||
        (c.company || '').toLowerCase().includes(needle) ||
        (c.email || '').toLowerCase().includes(needle) ||
        (c.city || '').toLowerCase().includes(needle)
      ))
      .slice(0, 50);
  }, [q, customers]);

  const exactMatch = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return customers.some((c) => (c.name || '').toLowerCase() === needle);
  }, [q, customers]);

  const showCreate = q.trim().length > 0 && !exactMatch;
  const totalRows = filtered.length + (showCreate ? 1 : 0);

  async function createAndSelect() {
    const name = q.trim();
    if (!name) return;
    const id = newId();
    await db.customers.put({
      id,
      profileId,
      name,
      company: '',
      email: '',
      phone: '',
      address: '',
      city: '',
      state: '',
      zip: '',
      country: '',
      notes: '',
      createdAt: Date.now(),
    });
    onSelect(id);
    onClose();
  }

  function pickAtIdx(i) {
    if (showCreate && i === 0) return createAndSelect();
    const c = filtered[i - (showCreate ? 1 : 0)];
    if (!c) return;
    onSelect(c.id);
    onClose();
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
   <>
    <Modal open={open} onClose={onClose} title="Cliente" size="md" footer={
      currentId ? (
        <button
          type="button"
          onClick={() => { onSelect(null); onClose(); }}
          className="btn-ghost text-ink-500 hover:text-red-600"
        >
          <UserX size={14} /> Quitar cliente
        </button>
      ) : null
    }>
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setActiveIdx(0); }}
          onKeyDown={onKeyDown}
          className="input pl-9"
          placeholder="Buscar por nombre, empresa, correo…"
        />
        {q && (
          <button
            type="button"
            onClick={() => { setQ(''); inputRef.current?.focus(); }}
            className="btn-icon absolute right-0.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
            aria-label="Limpiar"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="max-h-[60vh] overflow-y-auto -mx-1">
        {showCreate && (
          <div
            onMouseEnter={() => setActiveIdx(0)}
            className={`rounded-md mx-1 mb-1 flex flex-wrap items-stretch gap-1 transition-colors ${
              activeIdx === 0 ? 'bg-brand-50' : 'hover:bg-ink-50'
            }`}
          >
            <button
              type="button"
              onClick={createAndSelect}
              className="min-w-0 flex-1 text-left px-3 py-2.5 flex items-center gap-2.5"
            >
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex-shrink-0">
                <Plus size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <div className="text-sm text-brand-900">
                  Crear cliente: <b>&ldquo;{q.trim()}&rdquo;</b>
                </div>
                <div className="text-[11px] text-ink-500">
                  Se asigna al instante. Usa «Con detalles» para teléfono, correo y empresa.
                </div>
              </span>
            </button>
            <button
              type="button"
              onClick={openDetail}
              className="flex-shrink-0 self-center mr-1.5 px-2.5 py-1.5 min-h-9 coarse:min-h-11 rounded-md border border-ink-200 bg-white text-xs font-medium text-ink-700 hover:border-ink-900 hover:text-ink-900 active:bg-ink-100 transition-colors"
            >
              Con detalles
            </button>
          </div>
        )}

        {filtered.length === 0 && !showCreate ? (
          <div className="px-3 py-10 text-center text-sm text-ink-500">
            Sin clientes. Escribe un nombre para crear el primero.
          </div>
        ) : (
          filtered.map((c, i) => {
            const idx = i + (showCreate ? 1 : 0);
            const isActive = activeIdx === idx;
            const isCurrent = c.id === currentId;
            return (
              <button
                key={c.id}
                type="button"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pickAtIdx(idx)}
                className={`w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 flex items-center gap-2.5 transition-colors ${
                  isActive ? 'bg-ink-100' : 'hover:bg-ink-50'
                } ${isCurrent ? 'ring-1 ring-inset ring-brand-300' : ''}`}
              >
                <Avatar name={c.name} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink-900 truncate">
                    {c.name}
                    {isCurrent && <span className="ml-1.5 text-[10px] text-brand-700 font-medium">· actual</span>}
                  </div>
                  <div className="text-[11px] text-ink-500 truncate">
                    {[c.company, c.email, c.city].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </Modal>

    {/* Full customer form, stacked over the picker. Prefilled with the
        typed name; saving creates the customer and assigns it to the quote
        in one go — no detour through the Customers page. */}
    <CustomerModal
      key={detailDraft?.key ?? 'closed'}
      customer={detailDraft ? { name: detailDraft.name } : null}
      profileId={profileId}
      onClose={() => setDetailDraft(null)}
      onSaved={(id) => { onSelect(id); onClose(); }}
    />
   </>
  );
}

function Avatar({ name }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n.charAt(0).toUpperCase())
    .join('');
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-ink-100 text-ink-700 text-[10px] font-semibold flex-shrink-0">
      {initials || '?'}
    </span>
  );
}
