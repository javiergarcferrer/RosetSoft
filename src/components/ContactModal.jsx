import { useState } from 'react';
import { Trash2, Search, Loader2 } from 'lucide-react';
import Modal from './Modal.jsx';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { lookupRnc, cleanRnc } from '../lib/rncLookup.js';
import { phoneOwner, phoneInUseMessage } from '../lib/whatsapp.js';
import { userMessageFor } from '../lib/errorMessages.js';

/**
 * ContactModal — THE shared create/edit primitive for both customers and
 * professionals (they're the same kind of party: a name + fiscal id + contact +
 * notes). One component so the two entry flows never drift, with a
 * best-practices iOS entry UX baked in once:
 *   • the app's Modal (sheet on mobile, safe-areas + scroll-lock handled),
 *   • per-field `type`/`inputMode`/`autoComplete`/`autoCapitalize`/`autoCorrect`
 *     so iOS shows the right keyboard + autofill and never upper-cases an email,
 *   • `enterKeyHint` to chain fields (Next…Next…Done) instead of dismissing,
 *   • the DGII RNC lookup that fills the fiscal name, and the watertight
 *     one-number-one-contact phone guard.
 *
 * `kind` selects the field set + persistence: customers store the full postal
 * address; professionals carry a Ligne Roset trade number and a per-team
 * sequence. Thin wrappers (CustomerModal / ProfessionalModal) keep the original
 * prop names so existing call sites don't change.
 */
export default function ContactModal({ kind, record, onClose, onAfterDelete, onSaved, profileId }) {
  const isCustomer = kind === 'customer';
  const noun = isCustomer ? 'cliente' : 'profesional';
  const open = !!record;
  const isNew = !record?.id;
  const [data, setData] = useState(null);
  const [looking, setLooking] = useState(false);
  const [lookupMsg, setLookupMsg] = useState('');
  const [phoneErr, setPhoneErr] = useState('');
  const [saving, setSaving] = useState(false);

  if (open && data?.__id !== (record?.id || 'new')) {
    setLookupMsg('');
    setPhoneErr('');
    setData({
      __id: record?.id || 'new',
      name: record?.name || '',
      rnc: record?.rnc || '',
      rncStatus: record?.rncStatus || '',
      company: record?.company || '',
      email: record?.email || '',
      phone: record?.phone || '',
      notes: record?.notes || '',
      // customer-only
      contactName: record?.contactName || '',
      address: record?.address || '',
      city: record?.city || '',
      state: record?.state || '',
      zip: record?.zip || '',
      country: record?.country || '',
      // professional-only
      tradeNumber: record?.tradeNumber || '',
    });
  }
  if (!open || !data) return <Modal open={false} onClose={onClose} title="" />;

  const set = (k, v) => setData((d) => ({ ...d, [k]: v }));

  async function doLookup() {
    setLookupMsg('');
    setLooking(true);
    try {
      const r = await lookupRnc(data.rnc);
      if (r.found) {
        setData((d) => ({ ...d, name: r.name || d.name, company: r.commercialName || r.name || d.company, rncStatus: r.status || 'Verificado' }));
        setLookupMsg(`✓ ${r.name}${r.status ? ` · ${r.status}` : ''}`);
      } else {
        setData((d) => ({ ...d, rncStatus: '' }));
        setLookupMsg(r.message || 'No encontrado.');
      }
    } catch (e) {
      setLookupMsg(userMessageFor(e));
    } finally {
      setLooking(false);
    }
  }

  async function save() {
    if (!data.name.trim() || saving) return;
    const id = record?.id || newId();
    const now = Date.now();
    const phone = data.phone.trim();
    setSaving(true);
    try {
      // One WhatsApp number ↔ one contact: refuse a number already held by
      // another customer/professional (the inbox links a thread by phone).
      if (phone) {
        const owner = await phoneOwner({ phone, excludeId: id, profileId });
        if (owner) { setPhoneErr(phoneInUseMessage(owner)); return; }
      }
      const common = {
        id,
        profileId,
        name: data.name.trim(),
        rnc: cleanRnc(data.rnc),
        rncStatus: data.rncStatus || '',
        company: data.company.trim(),
        email: data.email.trim(),
        phone,
        notes: data.notes,
        createdAt: record?.createdAt || now,
        updatedAt: now,
      };
      if (isCustomer) {
        await db.customers.put({
          ...common,
          contactName: data.contactName.trim(),
          address: data.address.trim(),
          city: data.city.trim(),
          state: data.state.trim(),
          zip: data.zip.trim(),
          country: data.country.trim(),
        });
      } else {
        const core = { ...common, tradeNumber: data.tradeNumber.trim() };
        if (isNew) {
          await assignSequenceNumber({ table: 'professionals', profileId, start: 1, build: (number) => ({ ...core, number }) });
        } else {
          await db.professionals.put({ ...core, number: record.number });
        }
      }
      onSaved?.(id);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const msg = isCustomer
      ? `¿Eliminar el cliente "${data.name}"?`
      : `¿Eliminar a "${data.name}"? Las cotizaciones asignadas conservan el % pero pierden la referencia al profesional.`;
    if (!confirm(msg)) return;
    await db[isCustomer ? 'customers' : 'professionals'].delete(record.id);
    if (onAfterDelete) onAfterDelete();
    else onClose();
  }

  const title = isNew ? `Agregar ${noun}` : `Editar — ${data.name || (isCustomer ? 'Cliente' : 'Profesional')}`;

  return (
    <Modal open={open} onClose={onClose} title={title} footer={
      <>
        {!isNew && (
          <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50 hover:text-red-700">
            <Trash2 size={14} aria-hidden /> Eliminar
          </button>
        )}
        <div className="flex-1" />
        <button onClick={onClose} className="btn-ghost">Cancelar</button>
        <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-40">
          {saving ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null} Guardar
        </button>
      </>
    }>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* RNC / cédula + DGII lookup — fills the fiscal name for both kinds. */}
        <div className="sm:col-span-2">
          <div className="label">RNC / Cédula</div>
          <div className="flex gap-2">
            <input
              className="input flex-1 min-w-0" value={data.rnc}
              onChange={(e) => { set('rnc', e.target.value); if (data.rncStatus) set('rncStatus', ''); }}
              inputMode="numeric" autoComplete="off" placeholder="RNC (9 dígitos) o cédula (11)"
              enterKeyHint="search"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } }}
            />
            <button type="button" onClick={doLookup} disabled={looking || !cleanRnc(data.rnc)}
              className="btn-ghost inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap flex-shrink-0"
              title="Buscar el nombre en el registro de la DGII">
              {looking ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Search size={14} aria-hidden />} Buscar
            </button>
          </div>
          {lookupMsg && <p className={`text-xs mt-1.5 ${lookupMsg.startsWith('✓') ? 'text-emerald-600' : 'text-ink-500'}`}>{lookupMsg}</p>}
        </div>

        <div className="sm:col-span-2">
          <div className="label">Nombre *</div>
          <input className="input" value={data.name} onChange={(e) => set('name', e.target.value)}
            placeholder={isCustomer ? 'Razón social' : 'Nombre del profesional'}
            autoComplete="name" autoCapitalize="words" enterKeyHint="next" />
        </div>

        <div>
          <div className="label">{isCustomer ? 'Empresa' : 'Empresa / estudio'}</div>
          <input className="input" value={data.company} onChange={(e) => set('company', e.target.value)}
            placeholder={isCustomer ? 'Nombre comercial' : ''}
            autoComplete="organization" autoCapitalize="words" enterKeyHint="next" />
        </div>

        {isCustomer && (
          <div>
            <div className="label">Nombre de contacto</div>
            <input className="input" value={data.contactName} onChange={(e) => set('contactName', e.target.value)}
              placeholder="Persona de contacto" autoComplete="off" autoCapitalize="words" enterKeyHint="next" />
          </div>
        )}

        <div>
          <div className="label">Correo</div>
          <input className="input" type="email" value={data.email} onChange={(e) => set('email', e.target.value)}
            inputMode="email" autoComplete="email" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="next" />
        </div>

        <div>
          <div className="label">Teléfono</div>
          <input className={`input ${phoneErr ? 'border-rose-400 ring-1 ring-rose-300' : ''}`} type="tel"
            value={data.phone} onChange={(e) => { set('phone', e.target.value); if (phoneErr) setPhoneErr(''); }}
            inputMode="tel" autoComplete="tel" enterKeyHint="next" />
          {phoneErr && <p className="text-xs mt-1.5 text-rose-600">{phoneErr}</p>}
        </div>

        {!isCustomer && (
          <div className="sm:col-span-2">
            <div className="label">N.º de comercio Ligne Roset</div>
            <input className="input" value={data.tradeNumber} onChange={(e) => set('tradeNumber', e.target.value)}
              placeholder="Cuenta de comercio que asigna Ligne Roset"
              autoComplete="off" autoCapitalize="off" autoCorrect="off" enterKeyHint="next" />
            <p className="text-[11px] text-ink-400 mt-1">Aparece junto al decorador en el PDF de registro de pedido para Ligne Roset.</p>
          </div>
        )}

        {isCustomer && (
          <>
            <div>
              <div className="label">País</div>
              <input className="input" value={data.country} onChange={(e) => set('country', e.target.value)}
                autoComplete="country-name" autoCapitalize="words" enterKeyHint="next" />
            </div>
            <div className="sm:col-span-2">
              <div className="label">Dirección</div>
              <input className="input" value={data.address} onChange={(e) => set('address', e.target.value)}
                autoComplete="street-address" autoCapitalize="words" enterKeyHint="next" />
            </div>
            <div>
              <div className="label">Ciudad</div>
              <input className="input" value={data.city} onChange={(e) => set('city', e.target.value)}
                autoComplete="address-level2" autoCapitalize="words" enterKeyHint="next" />
            </div>
            <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2">
              <div>
                <div className="label">Provincia</div>
                <input className="input" value={data.state} onChange={(e) => set('state', e.target.value)}
                  autoComplete="address-level1" autoCapitalize="words" enterKeyHint="next" />
              </div>
              <div>
                <div className="label">Código postal</div>
                <input className="input" value={data.zip} onChange={(e) => set('zip', e.target.value)}
                  inputMode="numeric" autoComplete="postal-code" enterKeyHint="next" />
              </div>
            </div>
          </>
        )}

        <div className="sm:col-span-2">
          <div className="label">Notas</div>
          <textarea className="input min-h-[80px]" value={data.notes} onChange={(e) => set('notes', e.target.value)}
            autoCapitalize="sentences" enterKeyHint="done" />
        </div>
      </div>
    </Modal>
  );
}
