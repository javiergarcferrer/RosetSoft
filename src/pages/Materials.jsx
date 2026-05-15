import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { Plus, Search, Palette } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import { db, newId } from '../db/database.js';

const KIND_LABELS = {
  fabric: 'Fabric',
  leather: 'Leather',
  'outdoor-fabric': 'Outdoor Fabric',
};
const KIND_COLORS = {
  fabric: 'bg-blue-100 text-blue-800',
  leather: 'bg-amber-100 text-amber-800',
  'outdoor-fabric': 'bg-emerald-100 text-emerald-800',
};

export default function Materials() {
  const materials = useLiveQuery(() => db.materials.toArray(), [], []);
  const colors = useLiveQuery(() => db.materialColors.toArray(), [], []);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [grade, setGrade] = useState('');
  const [newOpen, setNewOpen] = useState(false);

  const counts = useMemo(() => {
    const byMat = new Map();
    for (const c of colors) byMat.set(c.materialId, (byMat.get(c.materialId) || 0) + 1);
    return byMat;
  }, [colors]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return materials
      .filter((m) => (kind ? m.kind === kind : true))
      .filter((m) => (grade ? m.grade === grade : true))
      .filter((m) => (!needle ? true : m.name.toLowerCase().includes(needle) || (m.composition || '').toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [materials, q, kind, grade]);

  const grades = [...new Set(materials.map((m) => m.grade).filter(Boolean))].sort();

  if (materials.length === 0) {
    return (
      <>
        <PageHeader title="Materials" subtitle="Fabrics, leathers, and outdoor fabrics" />
        <EmptyState
          icon={Palette}
          title="No materials yet"
          description="Add a fabric or leather by hand to get started."
          action={
            <button onClick={() => setNewOpen(true)} className="btn-primary">Add manually</button>
          }
        />
        <NewMaterialModal open={newOpen} onClose={() => setNewOpen(false)} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Materials"
        subtitle={`${materials.length} materials · ${colors.length} colors`}
        actions={<button onClick={() => setNewOpen(true)} className="btn-primary"><Plus size={14} /> Add material</button>}
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or composition…"
            className="input pl-9"
          />
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="input max-w-[180px]">
          <option value="">All types</option>
          <option value="fabric">Fabric</option>
          <option value="leather">Leather</option>
          <option value="outdoor-fabric">Outdoor Fabric</option>
        </select>
        <select value={grade} onChange={(e) => setGrade(e.target.value)} className="input max-w-[140px]">
          <option value="">All grades</option>
          {grades.map((g) => <option key={g} value={g}>Grade {g}</option>)}
        </select>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {filtered.map((m) => (
          <Link
            key={m.id}
            to={`/materials/${m.id}`}
            className="card block p-3 hover:bg-ink-50"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-sm">{m.name}</div>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ${KIND_COLORS[m.kind] || 'bg-ink-100 text-ink-700'}`}>{KIND_LABELS[m.kind] || m.kind}</span>
                  <span className="badge">{m.grade || '—'}</span>
                  {m.width && <span className="text-[10px] text-ink-500">{m.width}</span>}
                </div>
                {m.composition && (
                  <div className="text-[11px] text-ink-500 mt-1 truncate">{m.composition}</div>
                )}
              </div>
              <div className="text-right flex-shrink-0">
                {m.pricePerUnit && <div className="text-sm font-medium">${m.pricePerUnit}</div>}
                <div className="text-[10px] text-ink-500">{counts.get(m.id) || 0} {counts.get(m.id) === 1 ? 'color' : 'colores'}</div>
              </div>
            </div>
          </Link>
        ))}
        {filtered.length === 0 && (
          <div className="card card-pad text-center text-sm text-ink-500">No matches.</div>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table min-w-[680px]">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Grade</th>
                <th>Width</th>
                <th>Price/unit</th>
                <th>Composition</th>
                <th className="text-right">Colors</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link to={`/materials/${m.id}`} className="font-medium hover:underline">{m.name}</Link>
                  </td>
                  <td><span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${KIND_COLORS[m.kind] || 'bg-ink-100 text-ink-700'}`}>{KIND_LABELS[m.kind] || m.kind}</span></td>
                  <td><span className="badge">{m.grade || '—'}</span></td>
                  <td className="text-ink-600">{m.width || '—'}</td>
                  <td className="text-ink-600">{m.pricePerUnit ? `$${m.pricePerUnit}` : '—'}</td>
                  <td className="text-ink-500 text-xs max-w-xs truncate" title={m.composition}>{m.composition || '—'}</td>
                  <td className="text-right text-ink-500">{counts.get(m.id) || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="px-5 py-10 text-center text-sm text-ink-500">No matches.</div>}
      </div>

      <NewMaterialModal open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}

function NewMaterialModal({ open, onClose }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('fabric');
  const [grade, setGrade] = useState('A');

  async function save() {
    if (!name.trim()) return;
    const id = newId();
    await db.materials.put({
      id,
      name: name.trim().toUpperCase(),
      kind,
      grade,
      wear: null,
      martindale: null,
      width: null,
      pricePerUnit: null,
      composition: '',
      notes: '',
      restrictedToProductNames: [],
    });
    onClose();
    setName('');
    window.location.hash = `#/materials/${id}`;
  }

  return (
    <Modal open={open} onClose={onClose} title="Add material" footer={
      <>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={save} className="btn-primary">Create</button>
      </>
    }>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label">Name *</div>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DIVA" />
        </div>
        <div>
          <div className="label">Type</div>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="fabric">Fabric</option>
            <option value="leather">Leather</option>
            <option value="outdoor-fabric">Outdoor Fabric</option>
          </select>
        </div>
        <div>
          <div className="label">Grade</div>
          <select className="input" value={grade} onChange={(e) => setGrade(e.target.value)}>
            {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}
