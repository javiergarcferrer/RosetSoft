import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Search, Trash2, Users } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import { db, newId } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';

export default function Customers() {
  const { profileId } = useApp();
  const customers = useLiveQuery(
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
        title="Customers"
        subtitle={`${customers.length} customer${customers.length === 1 ? '' : 's'}`}
        actions={<button onClick={() => setEditing({})} className="btn-primary"><Plus size={14} /> Add customer</button>}
      />

      {customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No customers yet"
          description="Add your first customer to reuse their details when building quotes."
          action={<button onClick={() => setEditing({})} className="btn-primary">Add customer</button>}
        />
      ) : (
        <>
          <div className="flex items-center gap-3 mb-5">
            <div className="relative flex-1 max-w-md">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers…" className="input pl-9" />
            </div>
          </div>

          <div className="card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>City</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="cursor-pointer" onClick={() => setEditing(c)}>
                    <td className="font-medium">{c.name}</td>
                    <td className="text-ink-700">{c.company || '—'}</td>
                    <td className="text-ink-700">{c.email || '—'}</td>
                    <td className="text-ink-700">{c.phone || '—'}</td>
                    <td className="text-ink-700">{c.city || '—'}</td>
                    <td className="text-right w-20"><span className="text-xs text-ink-500">Edit</span></td>
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
    if (!confirm(`Delete customer "${data.name}"?`)) return;
    await db.customers.delete(customer.id);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'Add customer' : `Edit — ${data.name || 'Customer'}`} footer={
      <>
        {!isNew && <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50"><Trash2 size={14} /> Delete</button>}
        <div className="flex-1" />
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={save} className="btn-primary">Save</button>
      </>
    }>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <div className="label">Name *</div>
          <input className="input" value={data.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <div className="label">Company</div>
          <input className="input" value={data.company} onChange={(e) => set('company', e.target.value)} />
        </div>
        <div>
          <div className="label">Email</div>
          <input className="input" type="email" value={data.email} onChange={(e) => set('email', e.target.value)} />
        </div>
        <div>
          <div className="label">Phone</div>
          <input className="input" value={data.phone} onChange={(e) => set('phone', e.target.value)} />
        </div>
        <div>
          <div className="label">Country</div>
          <input className="input" value={data.country} onChange={(e) => set('country', e.target.value)} />
        </div>
        <div className="col-span-2">
          <div className="label">Address</div>
          <input className="input" value={data.address} onChange={(e) => set('address', e.target.value)} />
        </div>
        <div>
          <div className="label">City</div>
          <input className="input" value={data.city} onChange={(e) => set('city', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label">State</div>
            <input className="input" value={data.state} onChange={(e) => set('state', e.target.value)} />
          </div>
          <div>
            <div className="label">ZIP</div>
            <input className="input" value={data.zip} onChange={(e) => set('zip', e.target.value)} />
          </div>
        </div>
        <div className="col-span-2">
          <div className="label">Notes</div>
          <textarea className="input min-h-[80px]" value={data.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}
