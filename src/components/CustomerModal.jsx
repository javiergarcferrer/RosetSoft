import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import Modal from './Modal.jsx';
import { db, newId } from '../db/database.js';

/**
 * Customer create/edit modal. Used in two places (symmetric with
 * ProfessionalModal):
 *
 *   • Customers list — opened via the "Agregar cliente" button.
 *     Save closes the modal and the live query repaints the list.
 *
 *   • CustomerDetail — opened via the "Editar" action in the page
 *     header. Save just closes; the live query on the detail page
 *     repaints with the new values. Delete fires `onAfterDelete`,
 *     which the detail page uses to navigate back to /customers —
 *     without that hook the page would render "Cargando cliente…"
 *     forever after the row is gone.
 *
 * Prop shape:
 *   customer       — null/undefined when closed; the row (or {}
 *                    for "new") when open.
 *   onClose        — close handler. Called on save and any non-
 *                    delete close.
 *   onAfterDelete  — optional. Fired after a confirmed delete; the
 *                    detail page hooks this to navigate away.
 *                    Falls back to onClose() when omitted so the
 *                    list-page caller doesn't have to know.
 *   profileId      — team profile id; stamped on new rows.
 */
export default function CustomerModal({ customer, onClose, onAfterDelete, profileId }) {
  const open = !!customer;
  const isNew = !customer?.id;
  const [data, setData] = useState(null);

  // Reset when opening
  if (open && data?.__id !== (customer?.id || 'new')) {
    setData({
      __id: customer?.id || 'new',
      name: customer?.name || '',
      company: customer?.company || '',
      email: customer?.email || '',
      phone: customer?.phone || '',
      address: customer?.address || '',
      city: customer?.city || '',
      state: customer?.state || '',
      zip: customer?.zip || '',
      country: customer?.country || '',
      notes: customer?.notes || '',
    });
  }
  if (!open || !data) return <Modal open={false} onClose={onClose} title="" />;

  function set(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function save() {
    if (!data.name.trim()) return;
    const id = customer?.id || newId();
    await db.customers.put({
      id,
      profileId,
      name: data.name.trim(),
      company: data.company.trim(),
      email: data.email.trim(),
      phone: data.phone.trim(),
      address: data.address.trim(),
      city: data.city.trim(),
      state: data.state.trim(),
      zip: data.zip.trim(),
      country: data.country.trim(),
      notes: data.notes,
      createdAt: customer?.createdAt || Date.now(),
    });
    onClose();
  }

  async function remove() {
    if (!confirm(`¿Eliminar el cliente "${data.name}"?`)) return;
    await db.customers.delete(customer.id);
    // Prefer onAfterDelete when provided (the detail page navigates
    // back to /customers to avoid showing a forever-loading state
    // for the now-deleted row); fall back to onClose so the list
    // page works with the same API.
    if (onAfterDelete) onAfterDelete();
    else onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'Agregar cliente' : `Editar — ${data.name || 'Cliente'}`} footer={
      <>
        {!isNew && <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50"><Trash2 size={14} /> Eliminar</button>}
        <div className="flex-1" />
        <button onClick={onClose} className="btn-ghost">Cancelar</button>
        <button onClick={save} className="btn-primary">Guardar</button>
      </>
    }>
      {/* autoComplete + inputMode hints give iOS the right keyboard / autofill
          suggestion for each field. autoCapitalize on the email/phone keeps
          Safari from upper-casing the first letter, which is the default. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <div className="label">Nombre *</div>
          <input
            className="input"
            value={data.name}
            onChange={(e) => set('name', e.target.value)}
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="next"
          />
        </div>
        <div>
          <div className="label">Empresa</div>
          <input
            className="input"
            value={data.company}
            onChange={(e) => set('company', e.target.value)}
            autoComplete="organization"
            autoCapitalize="words"
            enterKeyHint="next"
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
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
          />
        </div>
        <div>
          <div className="label">Teléfono</div>
          <input
            className="input"
            type="tel"
            value={data.phone}
            onChange={(e) => set('phone', e.target.value)}
            inputMode="tel"
            autoComplete="tel"
            enterKeyHint="next"
          />
        </div>
        <div>
          <div className="label">País</div>
          <input
            className="input"
            value={data.country}
            onChange={(e) => set('country', e.target.value)}
            autoComplete="country-name"
            autoCapitalize="words"
            enterKeyHint="next"
          />
        </div>
        <div className="sm:col-span-2">
          <div className="label">Dirección</div>
          <input
            className="input"
            value={data.address}
            onChange={(e) => set('address', e.target.value)}
            autoComplete="street-address"
            autoCapitalize="words"
            enterKeyHint="next"
          />
        </div>
        <div>
          <div className="label">Ciudad</div>
          <input
            className="input"
            value={data.city}
            onChange={(e) => set('city', e.target.value)}
            autoComplete="address-level2"
            autoCapitalize="words"
            enterKeyHint="next"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label">Provincia</div>
            <input
              className="input"
              value={data.state}
              onChange={(e) => set('state', e.target.value)}
              autoComplete="address-level1"
              autoCapitalize="words"
              enterKeyHint="next"
            />
          </div>
          <div>
            <div className="label">Código postal</div>
            <input
              className="input"
              value={data.zip}
              onChange={(e) => set('zip', e.target.value)}
              inputMode="numeric"
              autoComplete="postal-code"
              enterKeyHint="next"
            />
          </div>
        </div>
        <div className="sm:col-span-2">
          <div className="label">Notas</div>
          <textarea
            className="input min-h-[80px]"
            value={data.notes}
            onChange={(e) => set('notes', e.target.value)}
            autoCapitalize="sentences"
            enterKeyHint="done"
          />
        </div>
      </div>
    </Modal>
  );
}
