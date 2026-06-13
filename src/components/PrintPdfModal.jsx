import { userMessageFor } from '../lib/errorMessages.js';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer, ArrowLeft, Loader2, AlertTriangle } from 'lucide-react';
import { renderPdfToImages } from '../lib/loadPdfjs.js';

/**
 * In-app print preview — THE print path for every generated PDF.
 *
 * Why this exists: every previous attempt handed the browser a PDF resource to
 * open (a hidden iframe or a popup tab pointed at a blob: URL) and asked it to
 * print. Whether that renders or *downloads* is the browser's decision, not
 * ours — Chrome downloads it outright when "Download PDFs" is enabled (Adobe
 * installs flip it), Safari has its own rules, and print() into Chrome's PDF
 * viewer fails silently half the time. As long as a PDF is navigated to, a
 * download is always a possible outcome.
 *
 * So we never navigate to the PDF. pdfjs rasterizes the SAME blob the export
 * button ships into page images rendered inside this modal, and printing is a
 * plain `window.print()` of OUR OWN page — print CSS (index.css, keyed on
 * body[data-print-pdf]) shows only the page images. No tab, no popup blocker,
 * no MIME sniffing, no browser PDF settings: a download is structurally
 * impossible, on every engine, including the iPad PWA.
 *
 * The dialog auto-opens once the pages are ready; the modal stays behind it as
 * the preview, with a button to print again (or after a cancel).
 */
export default function PrintPdfModal({ blob, title = 'Imprimir', onClose }) {
  const [pages, setPages] = useState(null);   // [{ src, width, height }]
  const [error, setError] = useState(null);
  const autoPrinted = useRef(false);

  // Mark the body while the modal lives so the @media print rules in
  // index.css swap the app for the page images. The zero @page margin is
  // injected here (not globally) because @page can't be scoped by selector
  // and the rest of the app must keep normal Cmd+P margins.
  useEffect(() => {
    document.body.setAttribute('data-print-pdf', '1');
    const style = document.createElement('style');
    style.textContent = '@page { margin: 0; }';
    document.head.appendChild(style);
    return () => {
      document.body.removeAttribute('data-print-pdf');
      style.remove();
    };
  }, []);

  // Rasterize the blob once. ~180 dpi pages — crisp on paper, light enough
  // that a long quote stays responsive.
  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setError(null);
    autoPrinted.current = false;
    renderPdfToImages(blob)
      .then((out) => { if (!cancelled) setPages(out); })
      .catch((e) => {
        console.error('[PrintPdfModal] render failed:', e);
        if (!cancelled) setError(userMessageFor(e));
      });
    return () => { cancelled = true; };
  }, [blob]);

  // Fire the print dialog automatically the first time the pages are in the
  // DOM and decoded — the user clicked "Imprimir" to get here, so the dialog
  // IS the expected next thing. Re-printing stays one tap away in the header.
  useEffect(() => {
    if (!pages || !pages.length || autoPrinted.current) return;
    autoPrinted.current = true;
    let cancelled = false;
    const imgs = Array.from(document.querySelectorAll('.print-pdf-page img'));
    Promise.allSettled(imgs.map((img) => img.decode?.() ?? Promise.resolve()))
      .then(() => {
        if (cancelled) return;
        // A beat for layout so the print engine captures painted pages.
        setTimeout(() => { if (!cancelled) window.print(); }, 60);
      });
    return () => { cancelled = true; };
  }, [pages]);

  return createPortal(
    <div className="print-pdf-root fixed inset-0 z-[100] flex items-stretch justify-center bg-black/60 sm:py-6 sm:px-4">
      <div className="print-pdf-frame flex w-full max-w-3xl flex-col bg-ink-100 sm:rounded-xl sm:shadow-pop overflow-hidden">
        {/* Header — hidden on paper (.print-pdf-chrome). On a phone the modal is
            full-screen, so the header pads itself past the iOS status bar
            (safe-area-inset-top) and leads with a BACK button — the standard
            mobile way out of a full-screen view. The print label collapses to
            its icon on narrow screens so nothing ever clips. */}
        <div className="print-pdf-chrome flex items-center gap-1.5 sm:gap-2 bg-white border-b border-ink-200 px-2 sm:px-4 py-2 sm:py-2.5 pt-[max(0.5rem,env(safe-area-inset-top))] sm:pt-2.5">
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost min-h-11 gap-1 px-2 flex-shrink-0"
            aria-label="Volver"
          >
            <ArrowLeft size={16} aria-hidden />
            <span className="hidden sm:inline">Volver</span>
          </button>
          <span className="font-display min-w-0 flex-1 break-words text-sm font-semibold text-ink-900">{title}</span>
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!pages || !pages.length}
            className="btn-brand flex-shrink-0 whitespace-nowrap"
          >
            <Printer size={14} aria-hidden /> Imprimir
          </button>
        </div>

        {/* Pages — the ONLY thing visible on paper. Bottom padding clears the
            home-indicator inset on full-screen mobile. */}
        <div className="print-pdf-pages flex-1 overflow-y-auto px-2 py-3 sm:px-6 sm:py-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {error ? (
            <div role="alert" className="print-pdf-chrome mx-auto mt-10 max-w-sm rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          ) : !pages ? (
            <div role="status" aria-live="polite" className="print-pdf-chrome flex flex-col items-center justify-center gap-3 py-24 text-ink-500">
              <Loader2 size={22} className="animate-spin" aria-hidden />
              <span className="text-xs font-medium">Preparando impresión…</span>
            </div>
          ) : (
            pages.map((p, i) => (
              <div key={i} className="print-pdf-page mx-auto mb-4 max-w-[820px] bg-white shadow-soft last:mb-0">
                <img
                  src={p.src}
                  width={p.width}
                  height={p.height}
                  alt={`Página ${i + 1}`}
                  className="block h-auto w-full"
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
