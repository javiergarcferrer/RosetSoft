import { useMemo, useState } from 'react';
import { Hash, Plus, Loader2, Check, X, Pencil } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
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
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const seqQ = useLiveQueryStatus(() => db.ecfSequences.where('profileId').equals(scope).toArray(), [scope], []);
  const [editing, setEditing] = useState(null); // null | 'new' | id
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const rows = useMemo(
    () => seqQ.data.slice().sort((a, b) => (a.ecfType || '').localeCompare(b.ecfType || '') || Number(a.seqFrom) - Number(b.seqFrom)),
    [seqQ.data],
  );

  function openNew() { setErr(''); setForm(blank()); setEditing('new'); }
  function openEdit(s) {
    setErr('');
    setForm({
      ecfType: s.ecfType, seqFrom: String(s.seqFrom), seqTo: String(s.seqTo),
      nextSeq: String(s.nextSeq), expires: s.expiresAt ? isoDate(s.expiresAt) : '', active: !!s.active,
    });
    setEditing(s.id);
  }

  async function save() {
    setErr('');
    const from = Math.trunc(Number(form.seqFrom) || 0);
    const to = Math.trunc(Number(form.seqTo) || 0);
    if (from <= 0 || to <= 0 || to < from) {
      setErr('Ingresa un rango válido: "Desde" y "Hasta" deben ser mayores a 0 y "Hasta" no puede ser menor que "Desde".');
      return;
    }
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

  const field = 'input';

  return (
    <AccountingGate title="Secuencias e-NCF">
      <PageHeader title="Secuencias e-NCF"
        subtitle="Rangos de e-NCF autorizados por la DGII; el sistema asigna el próximo al facturar"
        actions={<button type="button" onClick={openNew} className="btn-primary"><Plus size={15} /> Nueva secuencia</button>} />

      {editing && (
        <div className="card p-4 mb-4 border-ink-300">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-display font-semibold">{editing === 'new' ? 'Nueva secuencia' : 'Editar secuencia'}</h3>
            <button type="button" onClick={() => { setErr(''); setEditing(null); }} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Tipo e-CF<br />
              <select value={form.ecfType} onChange={(e) => setForm((f) => ({ ...f, ecfType: e.target.value }))} className={`${field} w-full sm:w-auto`}>
                {ECF_TYPES.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}
              </select>
            </label>
            <label className="text-sm">Desde<br /><input type="number" min="1" inputMode="numeric" value={form.seqFrom} onChange={(e) => setForm((f) => ({ ...f, seqFrom: e.target.value }))} className={`${field} w-28 tabular-nums`} /></label>
            <label className="text-sm">Hasta<br /><input type="number" min="1" inputMode="numeric" value={form.seqTo} onChange={(e) => setForm((f) => ({ ...f, seqTo: e.target.value }))} className={`${field} w-28 tabular-nums`} /></label>
            {editing !== 'new' && <label className="text-sm">Próximo<br /><input type="number" min="1" inputMode="numeric" value={form.nextSeq} onChange={(e) => setForm((f) => ({ ...f, nextSeq: e.target.value }))} className={`${field} w-28 tabular-nums`} /></label>}
            <label className="text-sm">Vence<br /><input type="date" value={form.expires} onChange={(e) => setForm((f) => ({ ...f, expires: e.target.value }))} className={`${field} w-full sm:w-auto`} /></label>
            <label className="inline-flex items-center gap-2 text-sm pb-1.5 min-h-9 coarse:min-h-11">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} className="w-4 h-4" /> Activa
            </label>
            <button type="button" onClick={save} disabled={saving} className="btn-primary ml-auto">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
            </button>
          </div>
          {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
        </div>
      )}

      {!seqQ.loaded ? <ListLoading /> : rows.length === 0 ? (
        <EmptyState icon={Hash} title="Sin secuencias"
          description="Carga los rangos de e-NCF que la DGII te autorizó." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="table min-w-[560px]">
            <thead>
              <tr>
                <th>Tipo</th>
                <th className="whitespace-nowrap">Rango</th>
                <th className="whitespace-nowrap">Próximo e-NCF</th>
                <th className="text-right whitespace-nowrap">Restan</th>
                <th className="whitespace-nowrap">Vence</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const st = sequenceState(s);
                const status = !s.active ? 'Inactiva' : st.expired ? 'Vencida' : st.exhausted ? 'Agotada' : 'Activa';
                const pill = status === 'Activa' ? 'status-pill-active' : status === 'Inactiva' ? 'status-pill-inactive' : 'status-pill-declined';
                return (
                  <tr key={s.id}>
                    <td className="min-w-0">{s.ecfType} · {ecfTypeLabel(s.ecfType)}</td>
                    <td className="tabular-nums text-ink-600 whitespace-nowrap">{s.seqFrom}–{s.seqTo}</td>
                    <td className="tabular-nums whitespace-nowrap">{st.nextENcf || '—'}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{st.remaining}</td>
                    <td className="text-ink-600 whitespace-nowrap">{s.expiresAt ? formatDate(s.expiresAt) : '—'}</td>
                    <td className="whitespace-nowrap"><span className={`status-pill ${pill}`}>{status}</span></td>
                    <td className="text-right">
                      <button type="button" onClick={() => openEdit(s)} className="inline-flex items-center gap-1 rounded-md px-2 min-h-8 coarse:min-h-11 text-xs font-medium text-ink-600 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors whitespace-nowrap" title="Editar secuencia"><Pencil size={13} /> Editar</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </AccountingGate>
  );
}
