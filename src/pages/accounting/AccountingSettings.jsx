import { useMemo, useState, useEffect } from 'react';
import { Shield, Settings2, Check, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, updateSettings } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { POSTING_ROLES, resolveAccountingConfig, postableAccounts } from '../../core/accounting/index.js';

/**
 * Configuración contable — the accountant maps each well-known posting role to
 * a chart account and sets the tax parameters (ITBIS, customs duty, retención
 * rates). Stored on the shared settings row; defaults (pre-wired to this
 * catálogo) come from lib/accounting/config. Self-gates on accounting/admin.
 */
const GROUP_ORDER = ['Activos', 'Pasivos', 'Ingresos', 'Costos', 'Gastos'];

export default function AccountingSettings() {
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

  const accountsQ = useLiveQueryStatus(
    () => db.accounts.where('profileId').equals(scope).toArray(), [scope], [],
  );
  const options = useMemo(
    () => postableAccounts(accountsQ.data).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );

  const resolved = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);
  const [form, setForm] = useState(resolved);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  // Re-seed the form whenever the persisted config changes (first load / refresh).
  useEffect(() => { setForm(resolved); }, [resolved]);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Configuración contable" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  function setRate(key, v) { setForm((f) => ({ ...f, [key]: v === '' ? '' : Number(v) })); }
  function setMap(role, code) { setForm((f) => ({ ...f, postingMap: { ...f.postingMap, [role]: code } })); }

  async function save() {
    setSaving(true);
    try {
      await updateSettings(scope, {
        accountingConfig: {
          itbisRate: Number(form.itbisRate) || 0,
          dutyRate: Number(form.dutyRate) || 0,
          retentionIsrServicesRate: Number(form.retentionIsrServicesRate) || 0,
          retentionItbisRate: Number(form.retentionItbisRate) || 0,
          postingMap: form.postingMap,
        },
      });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  const rateInput = 'w-24 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums';

  return (
    <>
      <PageHeader
        title="Configuración contable"
        subtitle="Parámetros fiscales y mapa de cuentas que usan los asientos automáticos"
        actions={
          <button type="button" onClick={save} disabled={saving}
            className="btn-primary text-sm inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
          </button>
        }
      />
      {savedAt > 0 && <p className="text-sm text-emerald-700 mb-3">Guardado.</p>}

      {!accountsQ.loaded ? <ListLoading /> : (
        <div className="space-y-6">
          <div className="card p-4">
            <h2 className="eyebrow font-semibold text-ink-600 mb-3 inline-flex items-center gap-1.5">
              <Settings2 size={15} /> Parámetros fiscales (%)
            </h2>
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3 max-w-2xl">
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">ITBIS</span>
                <input type="number" step="0.01" value={form.itbisRate} onChange={(e) => setRate('itbisRate', e.target.value)} className={rateInput} />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">Gravamen arancelario (importación)</span>
                <input type="number" step="0.01" value={form.dutyRate} onChange={(e) => setRate('dutyRate', e.target.value)} className={rateInput} />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">Retención ISR servicios (PF)</span>
                <input type="number" step="0.01" value={form.retentionIsrServicesRate} onChange={(e) => setRate('retentionIsrServicesRate', e.target.value)} className={rateInput} />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">Retención ITBIS servicios (PF)</span>
                <input type="number" step="0.01" value={form.retentionItbisRate} onChange={(e) => setRate('retentionItbisRate', e.target.value)} className={rateInput} />
              </label>
            </div>
            <p className="text-xs text-ink-400 mt-3">
              Las retenciones se aplican sólo cuando el proveedor lo requiere (configurable por proveedor en Compras/Gastos).
            </p>
          </div>

          <div className="card p-4">
            <h2 className="eyebrow font-semibold text-ink-600 mb-3">Mapa de cuentas</h2>
            <div className="space-y-5">
              {GROUP_ORDER.map((group) => {
                const roles = POSTING_ROLES.filter((r) => r.group === group);
                if (!roles.length) return null;
                return (
                  <div key={group}>
                    <h3 className="text-xs uppercase tracking-wide text-ink-400 mb-1">{group}</h3>
                    <div className="space-y-1.5">
                      {roles.map((r) => (
                        <div key={r.key} className="flex flex-wrap items-center gap-3">
                          <span className="text-sm w-56 shrink-0">{r.label}</span>
                          <select value={form.postingMap[r.key] || ''} onChange={(e) => setMap(r.key, e.target.value)}
                            className="flex-1 min-w-[240px] rounded-lg border border-ink-200 px-2 py-1.5 text-sm">
                            {options.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
