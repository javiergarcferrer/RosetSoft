import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import Modal from './Modal.jsx';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { phoneOwner, phoneInUseMessage } from '../lib/whatsapp.js';

/**
 * Professional create/edit modal. Used in two places:
 *
 *   • Professionals list — opened via the row click / "Editar" link.
 *     Save closes the modal and the live query repaints the list.
 *
 *   • ProfessionalDetail — opened via the "Editar" action in the
 *     page header. Save just closes; the live query on the detail
 *     page repaints with the new values. Delete fires
 *     `onAfterDelete`, which the detail page uses to navigate back
 *     to /professionals — without that hook the page would render
 *     "Cargando profesional…" forever after the row is gone.
 *
 * Prop shape:
 *   professional   — null/undefined when closed; the row (or {}
 *                    for "new") when open.
 *   onClose        — close handler. Called on save and any non-
 *                    delete close.
 *   onAfterDelete  — optional. Fired after a confirmed delete; the
 *                    detail page hooks this to navigate away.
 *                    Falls back to onClose() when omitted so the
 *                    list-page caller doesn't have to know.
 *   profileId      — team profile id; stamped on new rows and used
 *                    for the per-team sequence number.
 */
export default function ProfessionalModal({ professional, onClose, onAfterDelete, profileId }) {
  const open = !!professional;
  const isNew = !professional?.id;
  const [data, setData] = useState(null);
  const [phoneErr, setPhoneErr] = useState('');
  const [saving, setSaving] = useState(false);

  if (open && data?.__id !== (professional?.id || 'new')) {
    setPhoneErr('');
    setData({
      __id: professional?.id || 'new',
      name: professional?.name || '',
      rnc: professional?.rnc || '',
      rncStatus: professional?.rncStatus || '',
      company: professional?.company || '',
      email: professional?.email || '',
      phone: professional?.phone || '',
      notes: professional?.notes || '',
    });
  }
  if (!open || !data) return <Modal open={false} onClose={onClose} title="" />;

  function set(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function save() {
    if (!data.name.trim() || saving) return;
    const id = professional?.id || newId();
    const now = Date.now();
    const phone = data.phone.trim();
    setSaving(true);
    try {
    // Watertight WhatsApp-number relation: refuse a number already held by
    // another contact (customer or professional) — see CustomerModal.
    if (phone) {
      const owner = await phoneOwner({ phone, excludeId: id, profileId });
      if (owner) { setPhoneErr(phoneInUseMessage(owner)); return; }
    }
    // Sequential number — same numbering rule as customers/quotes:
    // max(number) + 1, or 1 if empty. Start from 1 (no vanity prefix;
    // professionals are an internal list). New rows go through the
    // race-safe assignSequenceNumber helper (retries on the
    // UNIQUE(profile_id, number) constraint added in migration
    // 20260519180000); edits keep the existing number unchanged.
    const recordCore = {
      id,
      profileId,
      name: data.name.trim(),
      // Carried through (set from the Profesionales panel's RNC auto-fill) so a
      // modal edit never drops it — the upsert sends the whole record.
      rnc: data.rnc || '',
      rncStatus: data.rncStatus || '',
      company: data.company.trim(),
      email: data.email.trim(),
      phone,
      notes: data.notes,
      createdAt: professional?.createdAt || now,
      updatedAt: now,
    };
    if (isNew) {
      await assignSequenceNumber({
        table: 'professionals',
        profileId,
        start: 1,
        build: (number) => ({ ...recordCore, number }),
      });
    } else {
      await db.professionals.put({ ...recordCore, number: professional.number });
    }
    onClose();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`¿Eliminar a "${data.name}"? Las cotizaciones asignadas conservan el % pero pierden la referencia al profesional.`)) return;
    await db.professionals.delete(professional.id);
    // Prefer onAfterDelete when provided (the detail page navigates
    // back to /professionals to avoid showing a forever-loading state
    // for the now-deleted row); fall back to onClose so the list
    // page works with the same API.
    if (onAfterDelete) onAfterDelete();
    else onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? 'Agregar profesional' : `Editar — ${data.name || 'Profesional'}`}
      footer={
        <>
          {!isNew && (
            <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50 hover:text-red-700">
              <Trash2 size={14} aria-hidden /> Eliminar
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="btn-ghost">Cancelar</button>
          <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-40">Guardar</button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <div className="label">Nombre *</div>
          <input
            className="input"
            value={data.name}
            onChange={(e) => set('name', e.target.value)}
            autoComplete="name"
            autoCapitalize="words"
          />
        </div>
        <div>
          <div className="label">Empresa / estudio</div>
          <input
            className="input"
            value={data.company}
            onChange={(e) => set('company', e.target.value)}
            autoComplete="organization"
            autoCapitalize="words"
          />
        </div>
        <div>
          <div className="label">Correo</div>
          <input
            className="input"
            type="email"
            value={data.email}
            onChange={(e) => set('email', e.target.value)}
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
        <div>
          <div className="label">Teléfono</div>
          <input
            className={`input ${phoneErr ? 'border-rose-400 ring-1 ring-rose-300' : ''}`}
            type="tel"
            value={data.phone}
            onChange={(e) => { set('phone', e.target.value); if (phoneErr) setPhoneErr(''); }}
            inputMode="tel"
            autoComplete="tel"
          />
          {phoneErr && <p className="text-xs mt-1.5 text-rose-600">{phoneErr}</p>}
        </div>
        <div className="sm:col-span-2">
          <div className="label">Notas</div>
          <textarea
            className="input min-h-[80px]"
            value={data.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
