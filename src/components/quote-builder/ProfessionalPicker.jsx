import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, X, UserX } from 'lucide-react';
import Modal from '../Modal.jsx';
import { db, newId, nextSequenceNumber } from '../../db/database.js';

/**
 * Modal professional picker with inline create. Mirrors CustomerPicker
 * (search → list, inline "Crear: 'XYZ'", keyboard navigation, "Quitar"
 * footer), but creates rows in the professionals table and seeds them
 * with the default 10% commission. The dealer can edit richer details
 * (company, email, exact %) on the Professionals page.
 */
export default function ProfessionalPicker({ open, onClose, onSelect, professionals, profileId, currentId }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActiveIdx(0);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return professionals.slice(0, 50);
    return professionals
      .filter((p) => (
        (p.name || '').toLowerCase().includes(needle) ||
        (p.company || '').toLowerCase().includes(needle) ||
        (p.email || '').toLowerCase().includes(needle)
      ))
      .slice(0, 50);
  }, [q, professionals]);

  const exactMatch = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return professionals.some((p) => (p.name || '').toLowerCase() === needle);
  }, [q, professionals]);

  const showCreate = q.trim().length > 0 && !exactMatch;
  const totalRows = filtered.length + (showCreate ? 1 : 0);

  async function createAndSelect() {
    const name = q.trim();
    if (!name) return;
    const id = newId();
    const number = await nextSequenceNumber('professionals', profileId, 1);
    const now = Date.now();
    await db.professionals.put({
      id,
      profileId,
      number,
      name,
      company: '',
      email: '',
      phone: '',
      notes: '',
      defaultCommissionPct: 10,
      createdAt: now,
      updatedAt: now,
    });
    onSelect(id);
    onClose();
  }

  function pickAtIdx(i) {
    if (showCreate && i === 0) return createAndSelect();
    const p = filtered[i - (showCreate ? 1 : 0)];
    if (!p) return;
    onSelect(p.id);
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
    <Modal open={open} onClose={onClose} title="Profesional" size="md" footer={
      currentId ? (
        <button
          type="button"
          onClick={() => { onSelect(null); onClose(); }}
          className="btn-ghost text-ink-500 hover:text-red-600"
        >
          <UserX size={14} /> Quitar profesional
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
            onClick={createAndSelect}
            className={`w-full text-left rounded-md px-3 py-2.5 mx-1 mb-1 flex items-center gap-2.5 transition-colors ${
              activeIdx === 0 ? 'bg-brand-50 text-brand-900' : 'hover:bg-ink-50'
            }`}
          >
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-amber-100 text-amber-700">
              <Plus size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <div className="text-sm">
                Crear profesional: <b>&ldquo;{q.trim()}&rdquo;</b>
              </div>
              <div className="text-[11px] text-ink-500">
                Comisión 10% por defecto. Edita los detalles desde Profesionales.
              </div>
            </span>
          </button>
        )}

        {filtered.length === 0 && !showCreate ? (
          <div className="px-3 py-10 text-center text-sm text-ink-500">
            Sin profesionales. Escribe un nombre para crear el primero.
          </div>
        ) : (
          filtered.map((p, i) => {
            const idx = i + (showCreate ? 1 : 0);
            const isActive = activeIdx === idx;
            const isCurrent = p.id === currentId;
            return (
              <button
                key={p.id}
                type="button"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pickAtIdx(idx)}
                className={`w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 flex items-center gap-2.5 transition-colors ${
                  isActive ? 'bg-ink-100' : 'hover:bg-ink-50'
                } ${isCurrent ? 'ring-1 ring-inset ring-amber-300' : ''}`}
              >
                <Avatar name={p.name} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink-900 truncate">
                    {p.name}
                    {isCurrent && <span className="ml-1.5 text-[10px] text-amber-700 font-medium">· actual</span>}
                  </div>
                  <div className="text-[11px] text-ink-500 truncate">
                    {[p.company, p.email].filter(Boolean).join(' · ') || `${p.defaultCommissionPct ?? 10}% por defecto`}
                  </div>
                </div>
                <span className="text-[11px] text-ink-500 tabular-nums whitespace-nowrap">
                  {p.defaultCommissionPct ?? 10}%
                </span>
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}

function Avatar({ name }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n.charAt(0).toUpperCase())
    .join('');
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold flex-shrink-0">
      {initials || '?'}
    </span>
  );
}
