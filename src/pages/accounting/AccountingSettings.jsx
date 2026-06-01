import { useMemo, useState, useEffect } from 'react';
import { Shield, Settings2, Check, Loader2, KeyRound, FileCheck } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, updateSettings } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDate } from '../../lib/format.js';
import { POSTING_ROLES, resolveAccountingConfig, postableAccounts } from '../../core/accounting/index.js';
import { saveEcfCredentials } from '../../lib/ecfCert.js';

const ECF_ENVS = [
  { value: 'cert', label: 'CerteCF (certificación)' },
  { value: 'dev', label: 'TesteCF (pruebas)' },
  { value: 'prod', label: 'eCF (producción)' },
];

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
  const [companyRnc, setCompanyRnc] = useState(settings?.companyRnc || '');
  const [ecfEnv, setEcfEnv] = useState(settings?.ecfEnvironment || 'cert');
  // Re-seed the form whenever the persisted config changes (first load / refresh).
  useEffect(() => { setForm(resolved); }, [resolved]);
  useEffect(() => {
    setCompanyRnc(settings?.companyRnc || '');
    setEcfEnv(settings?.ecfEnvironment || 'cert');
  }, [settings?.companyRnc, settings?.ecfEnvironment]);

  // e-CF certificate upload (separate write — the .p12 goes to the write-only
  // credentials table, never read back by the browser).
  const [certFile, setCertFile] = useState(null);
  const [certPassword, setCertPassword] = useState('');
  const [certSaving, setCertSaving] = useState(false);
  const [certMsg, setCertMsg] = useState('');

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
        companyRnc: companyRnc.trim(),
        ecfEnvironment: ecfEnv,
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

  async function saveCert() {
    setCertMsg('');
    setCertSaving(true);
    try {
      await saveEcfCredentials({ profileId: scope, file: certFile, password: certPassword, environment: ecfEnv });
      setCertFile(null);
      setCertPassword('');
      setCertMsg('✓ Certificado guardado de forma segura.');
    } catch (e) {
      setCertMsg(e?.message || 'No se pudo guardar el certificado.');
    } finally {
      setCertSaving(false);
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

          <div className="card p-4">
            <h2 className="eyebrow font-semibold text-ink-600 mb-3 inline-flex items-center gap-1.5">
              <FileCheck size={15} /> Comprobantes electrónicos (e-CF)
            </h2>
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3 max-w-2xl mb-4">
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">RNC del emisor</span>
                <input value={companyRnc} onChange={(e) => setCompanyRnc(e.target.value)}
                  className="w-44 rounded-lg border border-ink-200 px-2 py-1.5 text-sm tabular-nums" />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">Ambiente DGII</span>
                <select value={ecfEnv} onChange={(e) => setEcfEnv(e.target.value)}
                  className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm">
                  {ECF_ENVS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
              </label>
            </div>
            <div className="rounded-lg border border-ink-200 p-3 max-w-2xl">
              <div className="flex items-center gap-2 mb-2 text-sm font-medium text-ink-700">
                <KeyRound size={15} /> Certificado digital (.p12)
              </div>
              {settings?.ecfCertUploadedAt ? (
                <p className="text-xs text-emerald-700 mb-2">
                  Certificado cargado el {formatDate(settings.ecfCertUploadedAt)}. Sube uno nuevo para reemplazarlo.
                </p>
              ) : (
                <p className="text-xs text-ink-500 mb-2">
                  Sube tu certificado .p12 y su clave. Se guarda de forma segura y sólo el servidor de firma lo lee — el navegador nunca lo recupera.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input type="file" accept=".p12,.pfx" onChange={(e) => setCertFile(e.target.files?.[0] || null)} className="text-sm" />
                <input type="password" value={certPassword} onChange={(e) => setCertPassword(e.target.value)}
                  placeholder="Clave del .p12" className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm" />
                <button type="button" onClick={saveCert} disabled={certSaving || !certFile || !certPassword}
                  className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
                  {certSaving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar certificado
                </button>
              </div>
              {certMsg && <p className="text-sm mt-2 text-ink-600">{certMsg}</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
