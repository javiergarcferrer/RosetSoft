import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { Plus, Search, Palette } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import { db, newId } from '../db/database.js';

const KIND_LABELS = {
  fabric: 'Tela',
  leather: 'Cuero',
  'outdoor-fabric': 'Tela outdoor',
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
        <PageHeader title="Materiales" subtitle="Telas, cueros y telas outdoor" />
        <EmptyState
          icon={Palette}
          title="Sin materiales"
          description="Agrega una tela o cuero a mano para empezar."
          action={
            <button onClick={() => setNewOpen(true)} className="btn-primary">Agregar manualmente</button>
          }
        />
        <NewMaterialModal open={newOpen} onClose={() => setNewOpen(false)} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Materiales"
        subtitle={`${materials.length} ${materials.length === 1 ? 'material' : 'materiales'} · ${colors.length} ${colors.length === 1 ? 'color' : 'colores'}`}
        actions={<button onClick={() => setNewOpen(true)} className="btn-primary"><Plus size={14} /> Agregar material</button>}
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre o composición…"
            className="input pl-9"
          />
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="input max-w-[180px]">
          <option value="">Todos los tipos</option>
          <option value="fabric">Tela</option>
          <option value="leather">Cuero</option>
          <option value="outdoor-fabric">Tela outdoor</option>
        </select>
        <select value={grade} onChange={(e) => setGrade(e.target.value)} className="input max-w-[140px]">
          <option value="">Todos los grados</option>
          {grades.map((g) => <option key={g} value={g}>Grado {g}</option>)}
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
          <div className="card card-pad text-center text-sm text-ink-500">Sin coincidencias.</div>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table min-w-[680px]">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Grado</th>
                <th>Ancho</th>
                <th>Precio/unidad</th>
                <th>Composición</th>
                <th className="text-right">Colores</th>
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
        {filtered.length === 0 && <div className="px-5 py-10 text-center text-sm text-ink-500">Sin coincidencias.</div>}
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
    <Modal open={open} onClose={onClose} title="Agregar material" footer={
      <>
        <button onClick={onClose} className="btn-ghost">Cancelar</button>
        <button onClick={save} className="btn-primary">Crear</button>
      </>
    }>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label">Nombre *</div>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. DIVA" />
        </div>
        <div>
          <div className="label">Tipo</div>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="fabric">Tela</option>
            <option value="leather">Cuero</option>
            <option value="outdoor-fabric">Tela outdoor</option>
          </select>
        </div>
        <div>
          <div className="label">Grado</div>
          <select className="input" value={grade} onChange={(e) => setGrade(e.target.value)}>
            {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}
