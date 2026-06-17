// DriveDocumentsCard — attach a Google Drive folder to a record (an importation
// today; reusable for quotes/orders later) and manage its documents in place.
//
// Given a stored folderId (+ url) it lists the folder's files and lets the team
// upload more; with no folder yet it offers a one-tap "create folder" that calls
// the google-api function and hands the new id/url back via onFolderSaved so the
// caller can persist it on its record. All work is gated on a connected Google
// account (the Gmail/Drive integration); when disconnected it explains where to
// connect rather than failing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { HardDrive, FolderPlus, Upload, ExternalLink, RefreshCw, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext.jsx';
import { driveCreateFolder, driveUploadBlob, driveList } from '../../lib/google.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { formatDate } from '../../lib/format.js';

export default function DriveDocumentsCard({ folderId, folderUrl, folderName, parentId, onFolderSaved }) {
  const { settings } = useApp();
  const connected = !!settings?.googleConnectedAt;
  const fileInputRef = useRef(null);

  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);      // creating | uploading
  const [loading, setLoading] = useState(false); // listing
  const [err, setErr] = useState('');

  const refresh = useCallback(async (id) => {
    const fid = id || folderId;
    if (!fid) return;
    setLoading(true);
    setErr('');
    try {
      const data = await driveList(fid);
      setFiles(data?.files || []);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => { if (connected && folderId) refresh(folderId); }, [connected, folderId, refresh]);

  const createFolder = useCallback(async () => {
    setBusy(true);
    setErr('');
    try {
      const data = await driveCreateFolder({ name: folderName || 'Documentos', parentId });
      await onFolderSaved?.({ id: data.id, url: data.url || '' });
      await refresh(data.id);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }, [folderName, parentId, onFolderSaved, refresh]);

  const onPickFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file || !folderId) return;
    setBusy(true);
    setErr('');
    try {
      await driveUploadBlob({ folderId, filename: file.name, blob: file });
      await refresh(folderId);
    } catch (ex) {
      setErr(userMessageFor(ex));
    } finally {
      setBusy(false);
    }
  }, [folderId, refresh]);

  return (
    <div className="card overflow-hidden mt-4">
      <div className="card-header flex items-center justify-between">
        <h2 className="inline-flex items-center gap-1.5"><HardDrive size={14} /> Documentos (Drive)</h2>
        {folderId && (folderUrl || true) && (
          <a href={folderUrl || '#'} target="_blank" rel="noreferrer"
            className={`inline-flex items-center gap-1 text-xs text-brand-700 hover:underline ${folderUrl ? '' : 'pointer-events-none opacity-40'}`}>
            <ExternalLink size={12} /> Abrir carpeta
          </a>
        )}
      </div>

      <div className="p-3">
        {!connected ? (
          <p className="text-sm text-ink-500">
            Conecta Google Drive en{' '}
            <Link to="/integraciones" className="underline font-medium text-ink-700">Configuración → Integraciones</Link>{' '}
            para guardar los documentos de esta importación en la nube.
          </p>
        ) : !folderId ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-ink-500">Crea una carpeta en Drive para archivar los documentos de esta importación (BL, factura, DUA, etc.).</p>
            <button type="button" onClick={createFolder} disabled={busy} className="btn-secondary">
              {busy ? <RefreshCw size={14} className="animate-spin" /> : <FolderPlus size={14} />} Crear carpeta en Drive
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} className="btn-secondary">
                {busy ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />} Subir archivo
              </button>
              <button type="button" onClick={() => refresh(folderId)} disabled={loading} className="btn-icon text-ink-400" aria-label="Actualizar">
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
              <input ref={fileInputRef} type="file" className="hidden" onChange={onPickFile} />
            </div>

            {files.length === 0 ? (
              <p className="text-xs text-ink-400">{loading ? 'Cargando…' : 'Aún no hay documentos en esta carpeta.'}</p>
            ) : (
              <ul className="divide-y divide-ink-50 rounded-lg border border-ink-100">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <FileText size={14} className="shrink-0 text-ink-400" />
                    <a href={f.webViewLink || '#'} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-ink-700 hover:underline">{f.name}</a>
                    {f.modifiedTime && <span className="shrink-0 text-[11px] text-ink-400">{formatDate(Date.parse(f.modifiedTime))}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
      </div>
    </div>
  );
}
