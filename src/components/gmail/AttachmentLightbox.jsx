import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Download, ExternalLink, File as FileIcon, FileText, Loader2, Paperclip, X,
} from 'lucide-react';
import { renderPdfToImages } from '../../lib/loadPdfjs.js';
import { loadGmailAttachment } from '../../lib/gmail.js';

/**
 * The Gmail attachment lightbox. Fetches the bytes on demand (lib/gmail
 * loadGmailAttachment → an object URL), previews images and PDFs inline, and
 * offers a download for everything. The object URL is revoked on close so the
 * blob is freed.
 *
 * It receives the WHOLE message's attachment list plus the opened index, so the
 * dealer can page through every attachment (◂ ▸ / arrow keys) without closing —
 * the quick attachment navigation the phone experience is built around. On a
 * phone it goes full-screen (edge-to-edge) so a PDF/photo gets the whole window.
 */
export default function AttachmentLightbox({ messageId, attachments, index, onClose }) {
  const list = Array.isArray(attachments) ? attachments : [];
  const [i, setI] = useState(() => Math.min(Math.max(index || 0, 0), Math.max(list.length - 1, 0)));
  const [state, setState] = useState({ loading: true, error: '', url: '', blob: null });
  // PDF pages rasterized by pdfjs (data URLs) — the reliable way to preview a
  // blob PDF on every engine (the browser's own iframe/object viewer shows a
  // bare "Open" placeholder for blob URLs in many contexts, incl. the PWA).
  const [pdf, setPdf] = useState({ loading: false, error: '', pages: null });
  const a = list[i] || {};
  const mime = String(a.mimeType || '').toLowerCase();
  const isImg = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  const count = list.length;
  const go = useCallback((step) => setI((cur) => Math.min(Math.max(cur + step, 0), count - 1)), [count]);

  useEffect(() => {
    let url = '';
    let alive = true;
    setState({ loading: true, error: '', url: '', blob: null });
    loadGmailAttachment(messageId, a)
      .then((res) => {
        url = res.url;
        if (alive) setState({ loading: false, error: '', url, blob: res.blob });
        else URL.revokeObjectURL(url);
      })
      .catch((e) => {
        if (alive) setState({ loading: false, error: e?.message || 'No se pudo abrir el archivo.', url: '', blob: null });
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, a.attachmentId, i]);

  // Rasterize a PDF blob to page images once it's loaded.
  useEffect(() => {
    if (!isPdf || !state.blob) { setPdf({ loading: false, error: '', pages: null }); return undefined; }
    let alive = true;
    setPdf({ loading: true, error: '', pages: null });
    renderPdfToImages(state.blob)
      .then((pages) => { if (alive) setPdf({ loading: false, error: '', pages }); })
      .catch((e) => { if (alive) setPdf({ loading: false, error: e?.message || 'No se pudo mostrar el PDF.', pages: null }); });
    return () => { alive = false; };
  }, [isPdf, state.blob]);

  // Escape closes; ←/→ page between this message's attachments. Stop the event
  // so the inbox's own shortcut layer never sees keys aimed at the lightbox.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, go]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-0 md:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-full w-full max-w-4xl flex-col overflow-hidden bg-surface shadow-2xl md:h-auto md:max-h-[90vh] md:rounded-xl pt-[env(safe-area-inset-top)] md:pt-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-ink-800">
            <Paperclip size={14} className="shrink-0 text-ink-400" />
            <span className="truncate">{a.filename || 'archivo'}</span>
            {count > 1 && <span className="shrink-0 text-xs font-normal text-ink-400 tabular-nums">{i + 1}/{count}</span>}
          </span>
          <div className="flex items-center gap-2">
            {count > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => go(-1)}
                  disabled={i === 0}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50 disabled:opacity-40"
                  aria-label="Adjunto anterior"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  disabled={i >= count - 1}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50 disabled:opacity-40"
                  aria-label="Adjunto siguiente"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
            {state.url && (
              <a
                href={state.url}
                download={a.filename || 'archivo'}
                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
              >
                <Download size={13} /> <span className="hidden sm:inline">Descargar</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-lg border border-ink-200 bg-surface p-1.5 text-ink-600 hover:bg-ink-50"
              aria-label="Cerrar"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto bg-ink-50/40 p-2 md:p-4">
          {state.loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-ink-400">
              <Loader2 size={16} className="animate-spin" /> Cargando adjunto…
            </div>
          ) : state.error ? (
            <div className="py-20 text-center text-sm text-red-600">{state.error}</div>
          ) : isImg ? (
            <img src={state.url} alt={a.filename || 'adjunto'} className="mx-auto max-h-full max-w-full rounded object-contain" />
          ) : isPdf ? (
            // PDF: rasterized to page images by pdfjs (engine-independent — no
            // browser PDF plugin, so it works in the PWA where blob iframes show
            // only an "Open" placeholder). Falls back to open/download on error.
            pdf.loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-ink-400">
                <Loader2 size={16} className="animate-spin" /> Procesando PDF…
              </div>
            ) : pdf.pages?.length ? (
              <div className="mx-auto flex max-w-3xl flex-col items-center gap-3">
                {pdf.pages.map((p, idx) => (
                  <img
                    key={idx}
                    src={p.src}
                    width={p.width}
                    height={p.height}
                    alt={`Página ${idx + 1}`}
                    className="block h-auto w-full rounded bg-white shadow-soft"
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center text-sm text-ink-500">
                <FileText size={40} className="text-ink-300" />
                <p>{pdf.error || 'No se pudo mostrar la vista previa.'}</p>
                <div className="flex items-center gap-2">
                  <a href={state.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-ink-900 px-3 py-2 text-xs font-medium text-white hover:bg-ink-700">
                    <ExternalLink size={14} /> Abrir en pestaña
                  </a>
                  <a href={state.url} download={a.filename || 'archivo'} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50">
                    <Download size={14} /> Descargar
                  </a>
                </div>
              </div>
            )
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center text-sm text-ink-500">
              <FileIcon size={40} className="text-ink-300" />
              <p>Este tipo de archivo no se puede previsualizar.</p>
              <a
                href={state.url}
                download={a.filename || 'archivo'}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ink-900 px-3 py-2 text-xs font-medium text-white hover:bg-ink-700"
              >
                <Download size={14} /> Descargar archivo
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
