import { useMemo, useState } from 'react';
import { Shield, Hash, Plus, Loader2, Check, X, Pencil } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDate } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import { ECF_TYPES, ecfTypeLabel, sequenceState } from '../../core/accounting/index.js';

/**
 * Secuencias e-NCF — the DGII-authorized e-NCF ranges per e-CF type. The app
 * assigns the next e-NCF from the active range when invoicing (Facturación).
 * Self-gates on accounting/admin.
 */
function blank() {
  return { ecfType: '31', seqFrom: '1', seqTo: '', nextSeq: '', expires: '', active: true };
}

export default function ECFSequences() {
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

  const seqQ = useLiveQueryStatus(() => db.ecfSequences.where('profileId').equals(scope).toArray(), [scope], []);
  const [editing, setEditing] = useState(null); // null | 'new' | id
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);

  const rows = useMemo(
    () => seqQ.data.slice().sort((a, b) => (a.ecfType || '').localeCompare(b.ecfType || '') || Number(a.seqFrom) - Number(b.seqFrom)),
    [seqQ.data],
  );

  if (!allowed) {
    return (
      <>
        <PageHeader title="Secuencias e-NCF" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  function openNew() { setForm(blank()); setEditing('new'); }
  function openEdit(s) {
    setForm({
      ecfType: s.ecfType, seqFrom: String(s.seqFrom), seqTo: String(s.seqTo),
      nextSeq: String(s.nextSeq), expires: s.expiresAt ? isoDate(s.expiresAt) : '', active: !!s.active,
    });
    setEditing(s.id);
  }

  async function save() {
    const from = Math.trunc(Number(form.seqFrom) || 0);
    const to = Math.trunc(Number(form.seqTo) || 0);
    if (to < from || to <= 0) return;
    setSaving(true);
    try {
      const next = form.nextSeq ? Math.trunc(Number(form.nextSeq)) : from;
      const patch = {
        ecfType: form.ecfType, seqFrom: from, seqTo: to, nextSeq: next,
        expiresAt: form.expires ? parseISODate(form.expires, true) : null, active: !!form.active,
      };
      if (editing === 'new') {
        await db.ecfSequences.put({ id: newId(), profileId: scope, ...patch });
      } else {
        await db.ecfSequences.update(editing, patch);
      }
      setEditing(null);
    } finally {
      setSaving(false);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-3 py-1.5 text-sm';

  return (
    <>
      <PageHeader title="Secuencias e-NCF"
        subtitle="Rangos de e-NCF autorizados por la DGII; el sistema asigna el próximo al facturar"
        actions={<button type="button" onClick={openNew} className="btn-primary text-sm inline-flex items-center gap-1.5"><Plus size={15} /> Nueva secuencia</button>} />

      {editing && (
        <div className="card p-4 mb-4 border-ink-300">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">{editing === 'new' ? 'Nueva secuencia' : 'Editar secuencia'}</h3>
            <button type="button" onClick={() => setEditing(null)} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Tipo e-CF<br />
              <select value={form.ecfType} onChange={(e) => setForm((f) => ({ ...f, ecfType: e.target.value }))} className={field}>
                {ECF_TYPES.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}
              </select>
            </label>
            <label className="text-sm">Desde<br /><input type="number" min="1" value={form.seqFrom} onChange={(e) => setForm((f) => ({ ...f, seqFrom: e.target.value }))} className={`${field} w-28 tabular-nums`} /></label>
            <label className="text-sm">Hasta<br /><input type="number" min="1" value={form.seqTo} onChange={(e) => setForm((f) => ({ ...f, seqTo: e.target.value }))} className={`${field} w-28 tabular-nums`} /></label>
            {editing !== 'new' && <label className="text-sm">Próximo<br /><input type="number" min="1" value={form.nextSeq} onChange={(e) => setForm((f) => ({ ...f, nextSeq: e.target.value }))} className={`${field} w-28 tabular-nums`} /></label>}
            <label className="text-sm">Vence<br /><input type="date" value={form.expires} onChange={(e) => setForm((f) => ({ ...f, expires: e.target.value }))} className={field} /></label>
            <label className="inline-flex items-center gap-2 text-sm pb-1.5">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} /> Activa
            </label>
            <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm inline-flex items-center gap-1.5 ml-auto disabled:opacity-40">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
            </button>
          </div>
        </div>
      )}

      {!seqQ.loaded ? <ListLoading /> : rows.length === 0 ? (
        <EmptyState icon={Hash} title="Sin secuencias"
          description="Carga los rangos de e-NCF que la DGII te autorizó." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 px-3">Tipo</th>
                <th className="text-left py-2 px-3">Rango</th>
                <th className="text-left py-2 px-3">Próximo e-NCF</th>
                <th className="text-right py-2 px-3">Restan</th>
                <th className="text-left py-2 px-3">Vence</th>
                <th className="text-left py-2 px-3">Estado</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const st = sequenceState(s);
                const status = !s.active ? 'Inactiva' : st.expired ? 'Vencida' : st.exhausted ? 'Agotada' : 'Activa';
                const tone = status === 'Activa' ? 'text-emerald-700' : 'text-rose-600';
                return (
                  <tr key={s.id} className="border-t border-ink-50">
                    <td className="py-1.5 px-3">{s.ecfType} · {ecfTypeLabel(s.ecfType)}</td>
                    <td className="py-1.5 px-3 tabular-nums text-ink-600">{s.seqFrom}–{s.seqTo}</td>
                    <td className="py-1.5 px-3 tabular-nums">{st.nextENcf || '—'}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{st.remaining}</td>
                    <td className="py-1.5 px-3 text-ink-600">{s.expiresAt ? formatDate(s.expiresAt) : '—'}</td>
                    <td className={`py-1.5 px-3 ${tone}`}>{status}</td>
                    <td className="py-1.5 px-3 text-right">
                      <button type="button" onClick={() => openEdit(s)} className="text-ink-400 hover:text-ink-700"><Pencil size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
