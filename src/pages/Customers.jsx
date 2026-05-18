import { useMemo, useState } from 'react';
import { useLiveQueryStatus } from '../db/hooks.js';
import { Plus, Search, Trash2, Users } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import ListLoading from '../components/ListLoading.jsx';
import { db, newId } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';

export default function Customers() {
  const { profileId } = useApp();
  // useLiveQueryStatus lets us distinguish "fetch still in flight on
  // first mount" from "user really has zero customers" — without that
  // the page would flash the empty-state UI for one frame on every
  // navigation here, which read as a disingenuous "you have no data".
  const { data: customers, loaded } = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    []
  );
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return customers;
    return customers.filter((c) =>
      c.name?.toLowerCase().includes(needle) ||
      c.company?.toLowerCase().includes(needle) ||
      c.email?.toLowerCase().includes(needle)
    );
  }, [customers, q]);

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle={loaded ? `${customers.length} ${customers.length === 1 ? 'cliente' : 'clientes'}` : ' '}
        actions={<button onClick={() => setEditing({})} className="btn-primary"><Plus size={14} /> Agregar cliente</button>}
      />

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      ) : customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin clientes"
          description="Agrega tu primer cliente para reutilizar sus datos al crear cotizaciones."
          action={<button onClick={() => setEditing({})} className="btn-primary">Agregar cliente</button>}
        />
      ) : (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
            <div className="relative flex-1 max-w-md">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="search"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar clientes…"
                className="input pl-9"
              />
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setEditing(c)}
                className="card w-full text-left p-3 hover:bg-ink-50"
              >
                <div className="font-medium text-sm">{c.name}</div>
                {c.company && <div className="text-xs text-ink-500">{c.company}</div>}
                <div className="text-xs text-ink-700 mt-1 space-y-0.5">
                  {c.email && <div className="truncate">{c.email}</div>}
                  {c.phone && <div>{c.phone}</div>}
                  {c.city && <div className="text-ink-500">{c.city}</div>}
                </div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="card card-pad text-center text-sm text-ink-500">Sin coincidencias.</div>
            )}
          </div>

          {/* Desktop table — no overflow wrapper; lower-priority columns
              hide at sub-lg widths so the table never exceeds its container. */}
          <div className="hidden md:block card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Empresa</th>
                  <th className="hidden lg:table-cell">Correo</th>
                  <th className="hidden lg:table-cell">Teléfono</th>
                  <th className="hidden xl:table-cell">Ciudad</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="cursor-pointer" onClick={() => setEditing(c)}>
                    <td className="font-medium truncate max-w-[200px]" title={c.name}>{c.name}</td>
                    <td className="text-ink-700 truncate max-w-[200px]" title={c.company || ''}>{c.company || '—'}</td>
                    <td className="hidden lg:table-cell text-ink-700 truncate max-w-[200px]" title={c.email || ''}>{c.email || '—'}</td>
                    <td className="hidden lg:table-cell text-ink-700 whitespace-nowrap">{c.phone || '—'}</td>
                    <td className="hidden xl:table-cell text-ink-700 truncate max-w-[160px]" title={c.city || ''}>{c.city || '—'}</td>
                    <td className="text-right w-20"><span className="text-xs text-ink-500">Editar</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <CustomerModal customer={editing} onClose={() => setEditing(null)} profileId={profileId} />
    </>
  );
}

function CustomerModal({ customer, onClose, profileId }) {
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
    onClose();
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
