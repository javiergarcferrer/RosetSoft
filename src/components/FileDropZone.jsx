import { useRef, useState } from 'react';
import { UploadCloud, FileText, X, Loader2 } from 'lucide-react';

/**
 * Reusable file intake — drag, drop, click or paste a file, matching the
 * ImageDrop/DocExtras bar (dashed zone, hover + drag states, busy spinner).
 * Two modes:
 *   • mode="text" — reads the file as text and calls onText(text, file). For
 *     CSV/TSV imports that parse in the browser (no upload).
 *   • mode="file" — hands the File to onFile(file); the caller uploads it and
 *     drives `busy`/`error`/`fileName`.
 *
 * When `fileName` is set the zone collapses to a labeled chip with
 * Reemplazar / Quitar; otherwise it shows the drop prompt. `accept` is matched
 * leniently by extension (".csv") OR MIME ("text/csv", "image/*").
 */
export default function FileDropZone({
  mode = 'file', accept = '', label, hint, onText, onFile, onReject,
  busy = false, error = '', fileName = '', onClear, className = '', height = 'py-7',
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);

  function accepted(file) {
    if (!accept || !file) return true;
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    return accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((a) => (
      a.startsWith('.') ? name.endsWith(a)
        : a.endsWith('/*') ? type.startsWith(a.slice(0, -1))
          : type === a
    ));
  }

  async function handle(file) {
    if (!file) return;
    if (!accepted(file)) { onReject?.(file); return; }
    if (mode === 'text') {
      setReading(true);
      try { const text = await file.text(); onText?.(text, file); }
      finally { setReading(false); }
    } else {
      onFile?.(file);
    }
  }

  function onPaste(e) {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) { e.preventDefault(); handle(f); }
  }

  const working = busy || reading;

  return (
    <div className={className}>
      {label && <div className="label mb-1">{label}</div>}
      {fileName ? (
        <div className="flex items-center gap-2 rounded-lg border border-ink-200 bg-surface px-3 py-2">
          <FileText size={16} className="text-brand-500 shrink-0" />
          <span className="text-sm text-ink-700 truncate flex-1">{fileName}</span>
          {working && <Loader2 size={15} className="animate-spin text-ink-400 shrink-0" />}
          <button type="button" onClick={() => inputRef.current?.click()} disabled={working} className="text-xs font-medium text-ink-500 hover:text-ink-900 shrink-0">Reemplazar</button>
          {onClear && <button type="button" onClick={onClear} className="btn-icon text-ink-400 shrink-0" aria-label="Quitar archivo"><X size={15} /></button>}
        </div>
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files?.[0]); }}
          onPaste={onPaste}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
          role="button"
          tabIndex={0}
          className={`cursor-pointer rounded-lg border-2 border-dashed px-4 ${height} text-center transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${dragging ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-ink-50 hover:border-ink-300'}`}
        >
          {working ? <Loader2 size={20} className="animate-spin mx-auto text-ink-400" /> : <UploadCloud size={20} className="mx-auto text-ink-400" />}
          <div className="mt-1.5 text-sm text-ink-600">{working ? 'Procesando…' : 'Arrastra, pega o haz clic'}</div>
          {hint && <div className="text-xs text-ink-400 mt-0.5">{hint}</div>}
        </div>
      )}
      {error && <p className="text-xs text-rose-600 mt-1.5">{error}</p>}
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => { handle(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}
