// Mi Drive — a standalone Google Drive workspace for the team.
//
// Two jobs: PIN folders for one-click access (saved on the shared settings row,
// so the whole team sees the same shortcuts) and BROWSE/SEARCH the connected
// account's Drive (folders + files) to find and open documents. It reuses the
// same DriveExplorer the "add from Drive" picker uses, so navigation and pinning
// behave identically everywhere. Files open inside the app (Drive preview) with
// a link out; everything rides the single Google connection set up under
// Configuración → Integraciones.
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { HardDrive, Folder, ExternalLink, X, Pin } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import DriveExplorer from '../components/drive/DriveExplorer.jsx';
import { useApp } from '../context/AppContext.jsx';
import { driveFolderUrl } from '../lib/google.js';
import { userMessageFor } from '../lib/errorMessages.js';

export default function Drive() {
  const { settings, saveSettings } = useApp();
  const connected = !!settings?.googleConnectedAt;
  const pins = useMemo(() => settings?.googleDrivePins || [], [settings?.googleDrivePins]);

  const [preview, setPreview] = useState(null); // a file to view in-app
  const [err, setErr] = useState('');

  const togglePin = useCallback(async (folder) => {
    if (!folder?.id) return;
    setErr('');
    const exists = pins.some((p) => p.id === folder.id);
    const next = exists
      ? pins.filter((p) => p.id !== folder.id)
      : [...pins, { id: folder.id, name: folder.name || 'Carpeta', url: folder.url || driveFolderUrl(folder.id) }];
    try {
      await saveSettings({ googleDrivePins: next });
    } catch (e) {
      setErr(userMessageFor(e));
    }
  }, [pins, saveSettings]);

  const onFile = useCallback((f) => {
    // Folders are handled inside the explorer; here we only ever get files.
    setPreview(f);
  }, []);

  return (
    <>
      <PageHeader
        title="Google Drive"
        subtitle="Explora tu Drive, abre documentos y fija carpetas para acceso rápido."
      />

      {!connected ? (
        <EmptyState
          icon={HardDrive}
          title="Google Drive no está conectado"
          description="Conecta una cuenta de Google en Configuración → Integraciones para explorar tu Drive y fijar carpetas."
          action={<Link to="/integraciones" className="btn-primary text-sm">Ir a Integraciones</Link>}
        />
      ) : (
        <div className="max-w-3xl space-y-5">
          {/* Pinned folders — the easy-access shelf. */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-400">
              <Pin size={12} /> Carpetas fijadas
            </h2>
            {pins.length === 0 ? (
              <p className="text-sm text-ink-500">
                Aún no hay carpetas fijadas. Explora abajo y toca el <Pin size={12} className="inline -mt-0.5" /> en una carpeta para fijarla aquí.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {pins.map((p) => (
                  <div key={p.id} className="group flex items-center gap-2.5 rounded-xl border border-ink-200 bg-surface px-3 py-2.5">
                    <Folder size={18} className="shrink-0 text-brand-500" />
                    <a
                      href={p.url || driveFolderUrl(p.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate text-sm font-medium text-ink-800 hover:underline"
                    >
                      {p.name}
                    </a>
                    <a href={p.url || driveFolderUrl(p.id)} target="_blank" rel="noreferrer" className="shrink-0 text-ink-300 hover:text-ink-600" title="Abrir en Drive">
                      <ExternalLink size={14} />
                    </a>
                    <button type="button" onClick={() => togglePin(p)} className="shrink-0 text-ink-300 hover:text-rose-600" title="Quitar de fijados">
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {err && <p className="mt-2 text-sm text-rose-600">{err}</p>}
          </section>

          {/* Browser. */}
          <section className="card overflow-hidden">
            <div className="card-header flex items-center gap-1.5"><HardDrive size={14} /> Explorar Drive</div>
            <div className="p-3">
              <DriveExplorer onFile={onFile} pins={pins} onTogglePin={togglePin} />
            </div>
          </section>
        </div>
      )}

      {preview && (
        <Modal open onClose={() => setPreview(null)} title={preview.name} size="lg">
          <iframe
            title={preview.name}
            src={`https://drive.google.com/file/d/${preview.id}/preview`}
            className="h-[70vh] w-full rounded-lg border border-ink-100"
            allow="autoplay"
          />
          <div className="mt-2 text-right">
            <a href={preview.webViewLink || '#'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
              <ExternalLink size={12} /> Abrir en Drive
            </a>
          </div>
        </Modal>
      )}
    </>
  );
}
