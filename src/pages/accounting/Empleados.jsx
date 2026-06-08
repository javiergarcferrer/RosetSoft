import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, UserSquare2, Plus, Loader2, Check, X, Pencil } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop } from '../../lib/format.js';

/** Empleados — payroll master. Self-gates on accounting/admin. */
function blank() { return { name: '', cedula: '', position: '', monthlySalary: '', active: true }; }

export default function Empleados() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

  const empQ = useLiveQueryStatus(() => db.employees.where('profileId').equals(scope).toArray(), [scope], []);
  const [params] = useSearchParams();
  const [editing, setEditing] = useState(params.get('new') ? 'new' : null);
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Empleados" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  function openNew() { setForm(blank()); setEditing('new'); }
  function openEdit(e) {
    setForm({ name: e.name || '', cedula: e.cedula || '', position: e.position || '', monthlySalary: String(e.monthlySalary || ''), active: e.active !== false });
    setEditing(e.id);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const patch = {
        name: form.name.trim(), cedula: form.cedula.trim(), position: form.position.trim(),
        monthlySalary: Number(form.monthlySalary) || 0, active: !!form.active,
      };
      if (editing === 'new') {
        const id = newId();
        await assignSequenceNumber({ table: 'employees', profileId: scope, start: 1, build: (n) => ({ id, profileId: scope, number: n, ...patch }) });
      } else {
        await db.employees.update(editing, patch);
      }
      setEditing(null);
    } finally {
      setSaving(false);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-3 py-1.5 text-sm w-full min-h-[2.5rem] coarse:min-h-[2.75rem]';

  return (
    <>
      <PageHeader title="Empleados" subtitle={empQ.loaded ? `${empQ.data.length} empleados` : ' '}
        actions={<button type="button" onClick={openNew} className="btn-primary text-sm inline-flex items-center gap-1.5"><Plus size={15} /> Nuevo empleado</button>} />

      {editing && (
        <div className="card p-4 mb-4 border-ink-300">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">{editing === 'new' ? 'Nuevo empleado' : 'Editar empleado'}</h3>
            <button type="button" onClick={() => setEditing(null)} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 max-w-2xl">
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Nombre" className={field} />
            <input value={form.cedula} onChange={(e) => setForm((f) => ({ ...f, cedula: e.target.value }))} placeholder="Cédula" inputMode="numeric" className={field} />
            <input value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} placeholder="Cargo" className={field} />
            <input type="number" step="0.01" min="0" inputMode="decimal" enterKeyHint="done" value={form.monthlySalary} onChange={(e) => setForm((f) => ({ ...f, monthlySalary: e.target.value }))} placeholder="Salario mensual" className={`${field} text-right tabular-nums`} />
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-3">
            <label className="inline-flex items-center gap-2 text-sm min-h-[2.75rem]"><input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} /> Activo</label>
            <button type="button" onClick={save} disabled={saving || !form.name.trim()} className="btn-primary text-sm inline-flex items-center gap-1.5 ml-auto disabled:opacity-40">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
            </button>
          </div>
        </div>
      )}

      {!empQ.loaded ? <ListLoading /> : empQ.data.length === 0 ? (
        <EmptyState icon={UserSquare2} title="Sin empleados" description="Agrega tu primer empleado para correr la nómina." />
      ) : (
        <div className="card overflow-hidden">
          {/* Mobile: stacked cards */}
          <div className="sm:hidden divide-y divide-ink-50">
            {empQ.data.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((e) => (
              <div key={e.id} className="px-3 py-3 space-y-1">
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0">
                    <span className="font-medium text-ink-900 block truncate">{e.name}</span>
                    <span className="text-xs text-ink-500 truncate block">{e.position || '—'}{e.cedula ? ` · ${e.cedula}` : ''}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded ${e.active !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-100 text-ink-500'}`}>{e.active !== false ? 'Activo' : 'Inactivo'}</span>
                    <button type="button" onClick={() => openEdit(e)} className="text-ink-400 hover:text-ink-700 min-h-[2.75rem] min-w-[2.75rem] flex items-center justify-center"><Pencil size={14} /></button>
                  </div>
                </div>
                <div className="text-sm tabular-nums font-medium text-ink-700">{formatDop(e.monthlySalary)}</div>
              </div>
            ))}
          </div>
          {/* Desktop: table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                <tr><th className="text-left py-2 px-3">Empleado</th><th className="text-left py-2 px-3">Cédula</th><th className="text-left py-2 px-3">Cargo</th><th className="text-right py-2 px-3">Salario</th><th className="text-left py-2 px-3">Estado</th><th className="py-2 px-3"></th></tr>
              </thead>
              <tbody>
                {empQ.data.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((e) => (
                  <tr key={e.id} className="border-t border-ink-50">
                    <td className="py-1.5 px-3 font-medium">{e.name}</td>
                    <td className="py-1.5 px-3 tabular-nums text-ink-600">{e.cedula || '—'}</td>
                    <td className="py-1.5 px-3 text-ink-600">{e.position || '—'}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(e.monthlySalary)}</td>
                    <td className="py-1.5 px-3"><span className={`text-xs px-2 py-0.5 rounded ${e.active !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-100 text-ink-500'}`}>{e.active !== false ? 'Activo' : 'Inactivo'}</span></td>
                    <td className="py-1.5 px-3 text-right"><button type="button" onClick={() => openEdit(e)} className="text-ink-400 hover:text-ink-700"><Pencil size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
