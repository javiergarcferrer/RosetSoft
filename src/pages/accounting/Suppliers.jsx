import { useMemo, useState } from 'react';
import { Shield, Truck, Plus, Loader2, Check, X, Pencil, Search } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { classOf, postableAccounts } from '../../core/accounting/index.js';
import { lookupRnc, cleanRnc } from '../../lib/rncLookup.js';

const KIND_LABEL = { fisica: 'Persona física', juridica: 'Persona jurídica', exterior: 'Exterior' };

/**
 * Proveedores — supplier master for Gastos/Compras. Carries the RNC, tax
 * personhood and the per-supplier withholding flags (we retain ISR/ITBIS only
 * when the supplier requires it). Self-gates on accounting/admin.
 */
function blank() {
  return { name: '', rnc: '', kind: 'juridica', retainIsr: false, retainItbis: false, defaultAccountCode: '', email: '', phone: '' };
}

export default function Suppliers() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const expenseAccounts = useMemo(
    () => postableAccounts(accountsQ.data).filter((a) => classOf(a.code) === 6).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );

  const [editing, setEditing] = useState(null); // null | 'new' | <id>
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);
  const [looking, setLooking] = useState(false);
  const [lookupMsg, setLookupMsg] = useState('');

  async function doLookup() {
    setLookupMsg('');
    setLooking(true);
    try {
      const r = await lookupRnc(form.rnc);
      if (r.found) {
        setForm((f) => ({ ...f, name: r.name || f.name, kind: r.kind || f.kind }));
        setLookupMsg(`✓ ${r.name}${r.status ? ` · ${r.status}` : ''}${r.eInvoicer ? ' · e-CF' : ''}`);
      } else {
        setLookupMsg(r.message || 'No encontrado.');
      }
    } catch (e) {
      setLookupMsg(e?.message || 'Error consultando el RNC.');
    } finally {
      setLooking(false);
    }
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Proveedores" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  function openNew() { setForm(blank()); setLookupMsg(''); setEditing('new'); }
  function openEdit(s) {
    setLookupMsg('');
    setForm({
      name: s.name || '', rnc: s.rnc || '', kind: s.kind || 'juridica',
      retainIsr: !!s.retainIsr, retainItbis: !!s.retainItbis,
      defaultAccountCode: s.defaultAccountCode || '', email: s.email || '', phone: s.phone || '',
    });
    setEditing(s.id);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const patch = {
        name: form.name.trim(), rnc: form.rnc.trim(), kind: form.kind,
        retainIsr: form.retainIsr, retainItbis: form.retainItbis,
        defaultAccountCode: form.defaultAccountCode || null,
        email: form.email.trim(), phone: form.phone.trim(),
      };
      if (editing === 'new') {
        const id = newId();
        await assignSequenceNumber({
          table: 'suppliers', profileId: scope, start: 1,
          build: (number) => ({ id, profileId: scope, number, ...patch }),
        });
      } else {
        await db.suppliers.update(editing, patch);
      }
      setEditing(null);
    } finally {
      setSaving(false);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-3 py-1.5 text-sm';

  return (
    <>
      <PageHeader title="Proveedores"
        subtitle={suppliersQ.loaded ? `${suppliersQ.data.length} proveedores` : ' '}
        actions={<button type="button" onClick={openNew} className="btn-primary text-sm inline-flex items-center gap-1.5"><Plus size={15} /> Nuevo proveedor</button>} />

      {editing && (
        <div className="card p-4 mb-4 border-ink-300">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">{editing === 'new' ? 'Nuevo proveedor' : 'Editar proveedor'}</h3>
            <button type="button" onClick={() => setEditing(null)} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Nombre / razón social" className={field} />
            <div className="flex gap-2">
              <input value={form.rnc} onChange={(e) => setForm((f) => ({ ...f, rnc: e.target.value }))} placeholder="RNC / Cédula" className={`${field} flex-1`} />
              <button type="button" onClick={doLookup} disabled={looking || !cleanRnc(form.rnc)}
                className="btn-ghost text-sm inline-flex items-center gap-1 px-2.5 disabled:opacity-40" title="Buscar nombre en el registro DGII">
                {looking ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              </button>
            </div>
            <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))} className={field}>
              <option value="juridica">Persona jurídica</option>
              <option value="fisica">Persona física</option>
              <option value="exterior">Exterior</option>
            </select>
            <select value={form.defaultAccountCode} onChange={(e) => setForm((f) => ({ ...f, defaultAccountCode: e.target.value }))} className={field}>
              <option value="">Cuenta de gasto por defecto (opcional)</option>
              {expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </select>
            <input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="Email (opcional)" className={field} />
            <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="Teléfono (opcional)" className={field} />
          </div>
          {lookupMsg && <p className="text-sm text-ink-500 mt-2">{lookupMsg}</p>}
          <div className="flex flex-wrap items-center gap-5 mt-3">
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.retainIsr} onChange={(e) => setForm((f) => ({ ...f, retainIsr: e.target.checked }))} />
              Retener ISR
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.retainItbis} onChange={(e) => setForm((f) => ({ ...f, retainItbis: e.target.checked }))} />
              Retener ITBIS
            </label>
            <button type="button" onClick={save} disabled={saving || !form.name.trim()}
              className="btn-primary text-sm inline-flex items-center gap-1.5 ml-auto disabled:opacity-40">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
            </button>
          </div>
        </div>
      )}

      {!suppliersQ.loaded ? <ListLoading /> : suppliersQ.data.length === 0 ? (
        <EmptyState icon={Truck} title="Sin proveedores" description="Agrega tu primer proveedor." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 px-3">Proveedor</th>
                <th className="text-left py-2 px-3">RNC / Cédula</th>
                <th className="text-left py-2 px-3">Tipo</th>
                <th className="text-left py-2 px-3">Retención</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {suppliersQ.data.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => (
                <tr key={s.id} className="border-t border-ink-50">
                  <td className="py-1.5 px-3 font-medium">{s.name}</td>
                  <td className="py-1.5 px-3 tabular-nums text-ink-600">{s.rnc || '—'}</td>
                  <td className="py-1.5 px-3 text-ink-600">{KIND_LABEL[s.kind] || s.kind}</td>
                  <td className="py-1.5 px-3 text-ink-600">
                    {[s.retainIsr && 'ISR', s.retainItbis && 'ITBIS'].filter(Boolean).join(' + ') || '—'}
                  </td>
                  <td className="py-1.5 px-3 text-right">
                    <button type="button" onClick={() => openEdit(s)} className="text-ink-400 hover:text-ink-700"><Pencil size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
