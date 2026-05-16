import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

// Worker setup runs once at module load. pdfjs-dist 5.x ships an ES module
// worker; Vite's ?url import returns a static asset URL that the worker
// thread can fetch directly.
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

// Canvas is rendered at 1.5× the on-screen size for retina sharpness, then
// CSS-scaled back down. Bumping higher costs memory; lower visibly blurs.
const RETINA_SCALE = 1.5;

/**
 * Lightweight PDF page-by-page viewer backed by pdfjs.
 *
 * Optimized for the quote-builder side panel: keyboard nav, page jump,
 * zoom in/out, fit-to-width. The PDF document is loaded once (cancellable
 * destroy on unmount); each page render is also cancellable so quickly
 * paging through doesn't stack render tasks.
 *
 * @param {string|null} url       Public URL of the PDF. Null = empty state.
 * @param {number}      initialPage Page to open on first mount.
 */
export default function PdfViewer({ url, initialPage = 1 }) {
  const [pdf, setPdf] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const [pageInput, setPageInput] = useState(String(initialPage));
  const [loadError, setLoadError] = useState(null);
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // Load the document once per URL.
  useEffect(() => {
    if (!url) { setPdf(null); setNumPages(0); return; }
    let cancel = false;
    setLoadError(null);
    const task = pdfjs.getDocument({ url });
    task.promise.then((doc) => {
      if (cancel) { doc.destroy(); return; }
      setPdf(doc);
      setNumPages(doc.numPages);
      // Clamp the initial page in case the saved value points past the new PDF.
      setPage((p) => Math.min(Math.max(1, p), doc.numPages));
    }).catch((e) => {
      if (cancel) return;
      console.error('[PdfViewer] load failed', e);
      setLoadError(e?.message || 'No se pudo cargar el PDF.');
    });
    return () => {
      cancel = true;
      try { task.destroy(); } catch {}
    };
  }, [url]);

  // Render the current page whenever pdf / page / zoom changes. Cancellable
  // so rapid page input doesn't queue stale renders behind the active one.
  // Zoom is clamped to fit-to-container-width so the canvas never overflows
  // horizontally — horizontal scroll is banned throughout the app.
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancel = false;
    let renderTask = null;
    (async () => {
      try {
        const p = await pdf.getPage(page);
        if (cancel) return;
        const containerW = containerRef.current?.clientWidth || 0;
        const baseVp = p.getViewport({ scale: 1 });
        const maxScale = containerW > 32 ? (containerW - 32) / baseVp.width : zoom;
        const effective = Math.min(zoom, maxScale);
        const vp = p.getViewport({ scale: effective * RETINA_SCALE });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        canvas.style.width = `${vp.width / RETINA_SCALE}px`;
        canvas.style.height = `${vp.height / RETINA_SCALE}px`;
        const ctx = canvas.getContext('2d');
        renderTask = p.render({ canvasContext: ctx, viewport: vp });
        await renderTask.promise;
      } catch (e) {
        if (!cancel && e?.name !== 'RenderingCancelledException') {
          console.warn('[PdfViewer] render failed', e);
        }
      }
    })();
    return () => {
      cancel = true;
      try { renderTask?.cancel(); } catch {}
    };
  }, [pdf, page, zoom]);

  // Keep the controlled page-input field in sync when nav happens elsewhere.
  useEffect(() => { setPageInput(String(page)); }, [page]);

  function go(delta) {
    setPage((p) => Math.min(Math.max(1, p + delta), Math.max(1, numPages)));
  }

  function commitPageInput() {
    const n = Number(pageInput);
    if (Number.isFinite(n) && n >= 1 && n <= numPages) setPage(n);
    else setPageInput(String(page));
  }

  function fitToWidth() {
    const container = containerRef.current;
    if (!container || !pdf) return;
    pdf.getPage(page).then((p) => {
      const vp = p.getViewport({ scale: 1 });
      const available = container.clientWidth - 32;          // padding
      const next = Math.min(3, Math.max(0.3, available / vp.width));
      setZoom(next);
    }).catch(() => {});
  }

  // Empty / loading / error states
  if (!url) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-ink-500 px-6 text-center">
        Sube la lista de precios en <a href="#/settings" className="underline">Configuración</a> para verla aquí.
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-red-700 px-6 text-center">
        No se pudo cargar el PDF: {loadError}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-ink-50">
      <div className="flex items-center gap-1 px-1 py-1 border-b border-ink-100 bg-white text-xs">
        <button onClick={() => go(-1)} disabled={page <= 1} className="btn-icon disabled:opacity-30" aria-label="Página anterior">
          <ChevronLeft size={16} />
        </button>
        <input
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          min="1"
          max={numPages || 1}
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          onBlur={commitPageInput}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
          className="input w-14 text-center text-xs py-1 min-h-0 coarse:min-h-0"
          aria-label="Número de página"
        />
        <span className="text-ink-500 tabular-nums">/ {numPages || '…'}</span>
        <button onClick={() => go(1)} disabled={page >= numPages} className="btn-icon disabled:opacity-30" aria-label="Página siguiente">
          <ChevronRight size={16} />
        </button>
        <div className="flex-1" />
        <button onClick={() => setZoom((z) => Math.max(0.3, z / 1.2))} className="btn-icon" aria-label="Reducir zoom">
          <ZoomOut size={16} />
        </button>
        <span className="text-ink-500 tabular-nums w-10 text-right">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(3, z * 1.2))} className="btn-icon" aria-label="Aumentar zoom">
          <ZoomIn size={16} />
        </button>
        <button onClick={fitToWidth} className="btn-icon" aria-label="Ajustar al ancho" title="Ajustar al ancho">
          <Maximize2 size={16} />
        </button>
      </div>
      {/* The PDF canvas wants pinch-zoom; opt back in to it (overrides the
          global touch-action:manipulation that suppresses double-tap zoom). */}
      <div ref={containerRef} className="overflow-y-auto overflow-x-hidden p-3 flex-1 [touch-action:pinch-zoom]">
        <div className="flex justify-center">
          <canvas ref={canvasRef} className="shadow-md bg-white" />
        </div>
      </div>
    </div>
  );
}
