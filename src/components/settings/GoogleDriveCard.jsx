// Google Drive card — rides the SAME Google OAuth connection the Gmail card
// establishes (one account covers Gmail + Drive). Here the admin prepares the
// "RosetSoft" workspace folder: every importation (expediente) gets a subfolder
// under it where its documents are filed, and files can be attached from Drive
// elsewhere in the app.
import { useCallback, useState } from 'react';
import { HardDrive, RefreshCw, FolderPlus, ExternalLink } from 'lucide-react';
import SettingsSection from './SettingsSection.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { driveEnsureRoot } from '../../lib/google.js';
import { userMessageFor } from '../../lib/errorMessages.js';

export default function GoogleDriveCard() {
  const { settings, refreshSettings, isAdmin } = useApp();
  const connected = !!settings?.googleConnectedAt;
  const email = settings?.googleEmail || '';
  const rootReady = !!settings?.googleDriveRootFolderId;

  const [state, setState] = useState('idle'); // idle | working
  const [msg, setMsg] = useState(null); // { ok, text }
  const [rootUrl, setRootUrl] = useState('');

  const prepareRoot = useCallback(async () => {
    setState('working');
    setMsg(null);
    try {
      const data = await driveEnsureRoot();
      setRootUrl(data?.url || '');
      await refreshSettings?.();
      setMsg({ ok: true, text: 'Carpeta de trabajo lista en Google Drive ✓' });
    } catch (e) {
      setMsg({ ok: false, text: userMessageFor(e) });
    } finally {
      setState('idle');
    }
  }, [refreshSettings]);

  if (!isAdmin) return null;

  return (
    <SettingsSection title="Google Drive">
      <div className="space-y-4">
        <p className="text-xs text-ink-600 leading-relaxed">
          Guarda documentos en Google Drive: cada <strong>importación</strong> recibe su propia carpeta
          dentro de una carpeta de trabajo, y puedes adjuntar archivos desde Drive en la aplicación. Usa
          la misma conexión de Google que Gmail.
        </p>

        {!connected ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Conecta tu cuenta de Google primero desde la tarjeta de <strong>Gmail</strong> — una sola
            conexión habilita Gmail y Drive.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <HardDrive size={15} />
              <span>Conectado{email ? ` como ${email}` : ''}.</span>
            </div>

            <div className="rounded-lg border border-ink-100 bg-ink-50/40 p-3">
              <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">Carpeta de trabajo</div>
              <p className="text-xs text-ink-500 mb-2">
                {rootReady
                  ? 'La carpeta “RosetSoft” está lista. Las importaciones se archivan dentro de ella.'
                  : 'Crea la carpeta “RosetSoft” en tu Drive donde se organizarán todos los documentos.'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn-ghost min-h-[44px]" onClick={prepareRoot} disabled={state === 'working'}>
                  {state === 'working' ? <RefreshCw size={14} className="animate-spin" /> : <FolderPlus size={14} />}
                  {rootReady ? 'Verificar carpeta' : 'Preparar carpeta de trabajo'}
                </button>
                {rootUrl && (
                  <a href={rootUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
                    <ExternalLink size={12} /> Abrir en Drive
                  </a>
                )}
              </div>
            </div>
          </>
        )}

        {msg && <div className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</div>}
      </div>
    </SettingsSection>
  );
}
