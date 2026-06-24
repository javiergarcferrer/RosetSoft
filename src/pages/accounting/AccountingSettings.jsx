import { useMemo, useState, useEffect } from 'react';
import { Shield, Settings2, Check, Loader2, KeyRound, FileCheck } from 'lucide-react';
import { updateSettings } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import FileDropZone from '../../components/FileDropZone.jsx';
import { formatDate } from '../../lib/format.js';
import { resolveAccountingConfig } from '../../core/accounting/index.js';
import { saveEcfCredentials } from '../../lib/ecfCert.js';
import { signPostulacionXml } from '../../lib/ecfSend.js';
import { userMessageFor } from '../../lib/errorMessages.js';

const ECF_ENVS = [
  { value: 'cert', label: 'CerteCF (certificación)' },
  { value: 'dev', label: 'TesteCF (pruebas)' },
  { value: 'prod', label: 'eCF (producción)' },
];

/**
 * Configuración contable — the accountant sets the tax parameters (ITBIS,
 * customs duty, retención rates) and the e-CF credentials. The posting-account
 * map is deliberately NOT here: every role→code default lives in
 * lib/accounting/config (POSTING_ROLES), pre-wired to this catálogo, and the
 * chart of accounts is seeded, not edited in-app — so there is nothing to
 * re-bind. A wrong code is a one-line fix + deploy, never a settings knob whose
 * only effect would be to silently mis-book a real journal entry. Self-gates on
 * accounting/admin.
 */
export default function AccountingSettings() {
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';

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
  // Sign the DGII postulación XML in-app with the uploaded certificate.
  const [postFile, setPostFile] = useState(null);
  const [signingPost, setSigningPost] = useState(false);
  const [postMsg, setPostMsg] = useState('');

  async function signPostulacion() {
    if (!postFile) return;
    setPostMsg(''); setSigningPost(true);
    try {
      const signed = await signPostulacionXml({ xml: await postFile.text(), profileId: scope });
      const url = URL.createObjectURL(new Blob([signed], { type: 'application/xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = postFile.name.replace(/\.xml$/i, '') + '-firmado.xml';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setPostMsg('✓ Archivo firmado y descargado. Súbelo a la Oficina Virtual.');
    } catch (e) {
      setPostMsg(userMessageFor(e));
    } finally {
      setSigningPost(false);
    }
  }

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
      setCertMsg(userMessageFor(e));
    } finally {
      setCertSaving(false);
    }
  }

  const rateInput = 'input w-24 text-right tabular-nums';

  return (
    <>
      <PageHeader
        title="Configuración contable"
        subtitle="Parámetros fiscales y credenciales que usan los asientos automáticos y la facturación electrónica"
        actions={
          <button type="button" onClick={save} disabled={saving}
            className="btn-primary">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
          </button>
        }
      />
      {savedAt > 0 && <p className="text-sm text-emerald-700 mb-3">Guardado.</p>}

      <div className="space-y-6">
        <div className="card p-4">
          <h2 className="eyebrow font-semibold text-ink-600 mb-3 inline-flex items-center gap-1.5">
            <Settings2 size={15} /> Parámetros fiscales (%)
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 max-w-2xl">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">ITBIS</span>
              <input type="number" step="0.01" inputMode="decimal" value={form.itbisRate} onChange={(e) => setRate('itbisRate', e.target.value)} className={rateInput} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Gravamen arancelario (importación)</span>
              <input type="number" step="0.01" inputMode="decimal" value={form.dutyRate} onChange={(e) => setRate('dutyRate', e.target.value)} className={rateInput} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Retención ISR servicios (PF)</span>
              <input type="number" step="0.01" inputMode="decimal" value={form.retentionIsrServicesRate} onChange={(e) => setRate('retentionIsrServicesRate', e.target.value)} className={rateInput} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Retención ITBIS servicios (PF)</span>
              <input type="number" step="0.01" inputMode="decimal" value={form.retentionItbisRate} onChange={(e) => setRate('retentionItbisRate', e.target.value)} className={rateInput} />
            </label>
          </div>
          <p className="text-xs text-ink-400 mt-3">
            Las retenciones se aplican sólo cuando el proveedor lo requiere (configurable por proveedor en Compras/Gastos).
          </p>
        </div>

        <div className="card p-4">
          <h2 className="eyebrow font-semibold text-ink-600 mb-3 inline-flex items-center gap-1.5">
            <FileCheck size={15} /> Comprobantes electrónicos (e-CF)
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 max-w-2xl mb-4">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">RNC del emisor</span>
              <input value={companyRnc} onChange={(e) => setCompanyRnc(e.target.value)} inputMode="numeric"
                className="input w-36 min-w-0 tabular-nums" />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Ambiente DGII</span>
              <select value={ecfEnv} onChange={(e) => setEcfEnv(e.target.value)}
                className="input w-auto min-w-0 flex-shrink">
                {ECF_ENVS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </label>
          </div>
          <div className="surface-subtle p-3 max-w-2xl">
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
            <div className="space-y-2">
              <FileDropZone mode="file" accept=".p12,.pfx" height="py-4"
                hint="Arrastra tu certificado .p12 / .pfx o haz clic"
                fileName={certFile?.name || ''} onFile={(f) => setCertFile(f)} onClear={() => setCertFile(null)} />
              <div className="flex flex-wrap items-center gap-2">
                <input type="password" value={certPassword} onChange={(e) => setCertPassword(e.target.value)}
                  placeholder="Clave del .p12" className="input flex-1 min-w-[140px]" />
                <button type="button" onClick={saveCert} disabled={certSaving || !certFile || !certPassword}
                  className="btn-primary">
                  {certSaving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar certificado
                </button>
              </div>
            </div>
            {certMsg && <p className="text-sm mt-2 text-ink-600">{certMsg}</p>}
          </div>

          <div className="surface-subtle p-3 max-w-2xl mt-3">
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-ink-700">
              <FileCheck size={15} /> Firmar postulación (DGII)
            </div>
            <p className="text-xs text-ink-500 mb-2">
              Firma el XML del formulario de postulación con el certificado cargado — sin la app de Windows de la DGII.
              El certificado debe ser el del <b>representante legal registrado</b>. Descarga el archivo firmado y súbelo a la Oficina Virtual.
            </p>
            <div className="space-y-2">
              <FileDropZone mode="file" accept=".xml" height="py-4"
                hint="Arrastra el XML de postulación o haz clic"
                fileName={postFile?.name || ''} onFile={(f) => setPostFile(f)} onClear={() => setPostFile(null)} />
              <button type="button" onClick={signPostulacion} disabled={signingPost || !postFile || !settings?.ecfCertUploadedAt}
                className="btn-primary disabled:opacity-40">
                {signingPost ? <Loader2 size={15} className="animate-spin" /> : <FileCheck size={15} />} Firmar y descargar
              </button>
            </div>
            {!settings?.ecfCertUploadedAt ? <p className="text-xs text-amber-600 mt-2">Sube primero tu certificado .p12 arriba.</p> : null}
            {postMsg && <p className="text-sm mt-2 text-ink-600">{postMsg}</p>}
          </div>
        </div>
      </div>
    </>
  );
}
