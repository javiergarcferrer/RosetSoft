// DrivePickerModal — pick an existing file from Google Drive ("add from Drive").
//
// Reusable: opens recent files by default, searches by name on demand, and
// returns the chosen file ({ id, name, mimeType, webViewLink }) via onPick. The
// caller decides what to do with it (copy into a folder, attach a reference,
// etc.). Requires a connected Google account.
import { useCallback, useEffect, useState } from 'react';
import { Search, FileText, Loader2 } from 'lucide-react';
import Modal from '../Modal.jsx';
import { driveRecent, driveSearch } from '../../lib/google.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { formatDate } from '../../lib/format.js';

export default function DrivePickerModal({ open, onClose, onPick, picking = false }) {
  const [needle, setNeedle] = useState('');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (q) => {
    setLoading(true);
    setErr('');
    try {
      const data = q && q.trim() ? await driveSearch(q.trim()) : await driveRecent();
      setFiles(data?.files || []);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setNeedle('');
    load('');
  }, [open, load]);

  // Debounce the search box.
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => load(needle), 350);
    return () => clearTimeout(t);
  }, [needle, open, load]);

  return (
    <Modal open={open} onClose={onClose} title="Agregar desde Google Drive" size="lg">
      <div className="space-y-3">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
          <input className="input pl-8 text-sm" value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder="Buscar en Drive…" autoFocus />
        </div>

        {err && <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

        <div className="max-h-[50vh] overflow-y-auto rounded-lg ring-1 ring-inset ring-ink-100 divide-y divide-ink-50">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-ink-400"><Loader2 size={18} className="animate-spin" /></div>
          ) : files.length === 0 ? (
            <p className="text-xs text-ink-400 text-center py-8">{needle ? 'Sin resultados.' : 'Sin archivos recientes.'}</p>
          ) : (
            files.map((f) => (
              <button
                key={f.id}
                type="button"
                disabled={picking}
                onClick={() => onPick?.(f)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-ink-50/60 disabled:opacity-50"
              >
                <FileText size={15} className="shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink-800">{f.name}</span>
                {f.modifiedTime && <span className="shrink-0 text-[11px] text-ink-400">{formatDate(Date.parse(f.modifiedTime))}</span>}
              </button>
            ))
          )}
        </div>
        {picking && <p className="text-xs text-ink-500 flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Agregando…</p>}
      </div>
    </Modal>
  );
}
