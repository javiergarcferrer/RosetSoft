import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { UserSquare2, Plus, Loader2, Check, X, Pencil } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop } from '../../lib/format.js';

/** Empleados — payroll master. Self-gates on accounting/admin. */
function blank() { return { name: '', cedula: '', position: '', monthlySalary: '', active: true }; }

export default function Empleados() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const empQ = useLiveQueryStatus(() => db.employees.where('profileId').equals(scope).toArray(), [scope], []);
  const [params] = useSearchParams();
  const [editing, setEditing] = useState(params.get('new') ? 'new' : null);
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);

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

  const field = 'input';

  return (
    <AccountingGate title="Empleados">
      <PageHeader title="Empleados" subtitle={empQ.loaded ? `${empQ.data.length} empleados` : ' '}
        actions={<button type="button" onClick={openNew} className="btn-primary"><Plus size={15} /> Nuevo empleado</button>} />

      {editing && (
        <div className="card p-4 mb-4 border-ink-300">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-display font-semibold">{editing === 'new' ? 'Nuevo empleado' : 'Editar empleado'}</h3>
            <button type="button" onClick={() => setEditing(null)} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 max-w-2xl">
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Nombre" className={field} />
            <input value={form.cedula} onChange={(e) => setForm((f) => ({ ...f, cedula: e.target.value }))} placeholder="Cédula" inputMode="numeric" className={field} />
            <input value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} placeholder="Cargo" className={field} />
            <input type="number" step="0.01" min="0" inputMode="decimal" enterKeyHint="done" value={form.monthlySalary} onChange={(e) => setForm((f) => ({ ...f, monthlySalary: e.target.value }))} placeholder="Salario mensual" className={`${field} text-right tabular-nums`} />
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-3">
            <label className="inline-flex items-center gap-2 text-sm min-h-9 coarse:min-h-11"><input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} className="w-4 h-4" /> Activo</label>
            <button type="button" onClick={save} disabled={saving || !form.name.trim()} className="btn-primary ml-auto">
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
                    <span className="font-semibold text-ink-900 block break-words">{e.name}</span>
                    <span className="text-xs text-ink-500 block break-words">{e.position || '—'}{e.cedula ? <> · <span className="tabular-nums whitespace-nowrap">{e.cedula}</span></> : ''}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`status-pill ${e.active !== false ? 'status-pill-active' : 'status-pill-inactive'}`}>{e.active !== false ? 'Activo' : 'Inactivo'}</span>
                    <button type="button" onClick={() => openEdit(e)} className="inline-flex items-center gap-1 rounded-md px-2 min-h-8 coarse:min-h-11 text-xs font-medium text-ink-600 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors" title="Editar empleado"><Pencil size={13} /> Editar</button>
                  </div>
                </div>
                <div className="text-sm tabular-nums font-medium text-ink-700">{formatDop(e.monthlySalary)}</div>
              </div>
            ))}
          </div>
          {/* Desktop: table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Empleado</th><th>Cédula</th><th>Cargo</th><th className="text-right">Salario</th><th>Estado</th><th></th></tr>
              </thead>
              <tbody>
                {empQ.data.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((e) => (
                  <tr key={e.id}>
                    <td className="font-medium">{e.name}</td>
                    <td className="tabular-nums text-ink-600 whitespace-nowrap">{e.cedula || '—'}</td>
                    <td className="text-ink-600">{e.position || '—'}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{formatDop(e.monthlySalary)}</td>
                    <td><span className={`status-pill ${e.active !== false ? 'status-pill-active' : 'status-pill-inactive'}`}>{e.active !== false ? 'Activo' : 'Inactivo'}</span></td>
                    <td className="text-right"><button type="button" onClick={() => openEdit(e)} className="inline-flex items-center gap-1 rounded-md px-2 min-h-8 coarse:min-h-11 text-xs font-medium text-ink-600 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors whitespace-nowrap" title="Editar empleado"><Pencil size={13} /> Editar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AccountingGate>
  );
}
