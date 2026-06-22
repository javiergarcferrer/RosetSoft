// DriveExplorer — a navigable Google Drive browser (folders + files).
//
// Descend into folders (a breadcrumb climbs back), search by name across the
// whole Drive, and jump to a pinned folder. A file row calls `onFile(file)` —
// the caller decides what that means (open, preview, copy into a record…). When
// `onTogglePin` is passed, each folder (and the current one) carries a pin
// toggle so the team can favourite it for quick access. All data comes from
// lib/google; the caller gates on a connected Google account.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Folder, FileText, Loader2, ChevronRight, Home, Pin, ExternalLink } from 'lucide-react';
import { driveList, driveSearch, driveFolderUrl, isDriveFolder } from '../../lib/google.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { formatDate } from '../../lib/format.js';

const ROOT = { id: 'root', name: 'Mi unidad' };

export default function DriveExplorer({ onFile, pins = [], onTogglePin, busy = false }) {
  const [trail, setTrail] = useState([ROOT]); // breadcrumb stack
  const [needle, setNeedle] = useState('');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const current = trail[trail.length - 1];
  const searching = needle.trim().length > 0;
  const pinnedIds = useMemo(() => new Set(pins.map((p) => p.id)), [pins]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = searching ? await driveSearch(needle.trim()) : await driveList(current.id);
      setFiles(data?.files || []);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setLoading(false);
    }
  }, [searching, needle, current.id]);

  // Folder changes load at once; the search box is debounced.
  useEffect(() => {
    if (searching) {
      const t = setTimeout(load, 350);
      return () => clearTimeout(t);
    }
    load();
    return undefined;
  }, [load, searching]);

  const openFolder = (f) => { setNeedle(''); setTrail((t) => [...t, { id: f.id, name: f.name }]); };
  const goTo = (idx) => { setNeedle(''); setTrail((t) => t.slice(0, idx + 1)); };
  const jumpPin = (pin) => { setNeedle(''); setTrail([ROOT, { id: pin.id, name: pin.name }]); };
  const togglePin = (f) =>
    onTogglePin?.({ id: f.id, name: f.name, url: f.webViewLink || driveFolderUrl(f.id) });

  return (
    <div className="space-y-3">
      {pins.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pins.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => jumpPin(p)}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
            >
              <Pin size={11} className="fill-current" /> <span className="max-w-[12rem] truncate">{p.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
        <input
          className="input pl-8 text-sm"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          placeholder="Buscar en todo Drive…"
        />
      </div>

      {!searching && (
        <nav className="flex flex-wrap items-center gap-0.5 text-xs text-ink-500" aria-label="Ruta">
          {trail.map((node, i) => (
            <span key={node.id} className="inline-flex items-center gap-0.5">
              {i > 0 && <ChevronRight size={12} className="text-ink-300" />}
              <button
                type="button"
                onClick={() => goTo(i)}
                disabled={i === trail.length - 1}
                className={`inline-flex items-center gap-1 rounded px-1 py-0.5 ${i === trail.length - 1 ? 'font-medium text-ink-700' : 'hover:bg-ink-50 hover:text-ink-700'}`}
              >
                {i === 0 && <Home size={12} />}
                <span className="max-w-[12rem] truncate">{node.name}</span>
              </button>
            </span>
          ))}
        </nav>
      )}

      {err && <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

      <div className="max-h-[50vh] overflow-y-auto rounded-lg ring-1 ring-inset ring-ink-100 divide-y divide-ink-50">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-ink-400"><Loader2 size={18} className="animate-spin" /></div>
        ) : files.length === 0 ? (
          <p className="text-xs text-ink-400 text-center py-8">{searching ? 'Sin resultados.' : 'Esta carpeta está vacía.'}</p>
        ) : (
          files.map((f) => {
            const folder = isDriveFolder(f);
            const pinned = pinnedIds.has(f.id);
            return (
              <div key={f.id} className="group flex items-center gap-2.5 px-3 py-2 hover:bg-ink-50/60">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => (folder ? openFolder(f) : onFile?.(f))}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:opacity-50"
                >
                  {folder ? <Folder size={15} className="shrink-0 text-brand-500" /> : <FileText size={15} className="shrink-0 text-ink-400" />}
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-800">{f.name}</span>
                  {f.modifiedTime && <span className="shrink-0 text-[11px] text-ink-400">{formatDate(Date.parse(f.modifiedTime))}</span>}
                </button>
                {folder && onTogglePin && (
                  <button
                    type="button"
                    onClick={() => togglePin(f)}
                    title={pinned ? 'Quitar de fijados' : 'Fijar para acceso rápido'}
                    className={`shrink-0 ${pinned ? 'text-brand-600' : 'text-ink-300 hover:text-ink-600 opacity-0 group-hover:opacity-100'}`}
                  >
                    <Pin size={14} className={pinned ? 'fill-current' : ''} />
                  </button>
                )}
                <a
                  href={f.webViewLink || (folder ? driveFolderUrl(f.id) : '#')}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-ink-300 hover:text-ink-600 opacity-0 group-hover:opacity-100"
                  title="Abrir en Drive"
                >
                  <ExternalLink size={13} />
                </a>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
