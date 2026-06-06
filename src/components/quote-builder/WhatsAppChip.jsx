import { useState } from 'react';
import { MessageCircle, Check, X, Pencil } from 'lucide-react';
import { db } from '../../db/database.js';

/**
 * Digits-only number for a wa.me link. DR-friendly: a bare 10-digit local
 * number (area + line, no country code) gets a leading "1" (+1); anything that
 * already carries a country code is left as typed. Non-digits (spaces, dashes,
 * "+") are stripped — wa.me wants pure digits.
 */
export function waDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 ? `1${d}` : d;
}

/**
 * The quote customer's WhatsApp number, editable inline from the header — so
 * adding it is one click without leaving the quote pane. The number lives on the
 * CUSTOMER (`customer.phone`, the same number the rest of the app already shows),
 * so it's captured once and reused on every quote for that client; saving writes
 * straight to the customer row. Empty → a dashed "Agregar WhatsApp" affordance;
 * set → opens a WhatsApp chat to that number, with a pencil to edit. Hidden until
 * a customer is assigned (the CustomerChip prompts that first — there's no one to
 * attach a number to yet).
 */
export default function WhatsAppChip({ customer }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  if (!customer) return null;
  const phone = customer.phone || '';

  function startEdit() {
    setValue(phone);
    setEditing(true);
  }
  async function save() {
    const next = value.trim();
    if (next !== phone) await db.customers.update(customer.id, { phone: next || null });
    setEditing(false);
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-white px-2 min-h-7 coarse:min-h-9 text-xs shadow-xs ring-1 ring-inset ring-emerald-200/50">
        <MessageCircle size={12} className="text-emerald-600 flex-shrink-0" aria-hidden />
        <input
          autoFocus
          type="tel"
          inputMode="tel"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          placeholder="809 000 0000"
          className="w-28 bg-transparent border-0 p-0 text-xs text-ink-900 focus:outline-none focus:ring-0"
          aria-label="Número de WhatsApp"
        />
        <button type="button" onClick={save} title="Guardar" aria-label="Guardar" className="text-emerald-600 hover:text-emerald-700 flex-shrink-0">
          <Check size={13} />
        </button>
        <button type="button" onClick={() => setEditing(false)} title="Cancelar" aria-label="Cancelar" className="text-ink-300 hover:text-ink-600 flex-shrink-0">
          <X size={13} />
        </button>
      </span>
    );
  }

  if (!phone) {
    return (
      <button
        type="button"
        onClick={startEdit}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-3 py-1 text-xs text-ink-500 hover:border-emerald-400 hover:text-emerald-700 hover:bg-emerald-50/50 transition-all active:scale-[0.98]"
      >
        <MessageCircle size={12} /> Agregar WhatsApp
      </button>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ink-200 bg-white px-2.5 min-h-7 coarse:min-h-9 text-xs ring-1 ring-inset ring-black/5">
      <a
        href={`https://wa.me/${waDigits(phone)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-emerald-600 hover:text-emerald-700 min-w-0 transition-colors"
        title={`Abrir WhatsApp · ${phone}`}
      >
        <MessageCircle size={12} className="flex-shrink-0" aria-hidden />
        <span className="font-semibold truncate max-w-[120px] sm:max-w-[150px]">{phone}</span>
      </a>
      <button type="button" onClick={startEdit} title="Editar número" aria-label="Editar número de WhatsApp" className="text-ink-300 hover:text-ink-600 flex-shrink-0 transition-colors p-0.5 rounded">
        <Pencil size={10} />
      </button>
    </span>
  );
}
