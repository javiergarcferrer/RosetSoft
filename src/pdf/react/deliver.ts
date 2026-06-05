import { shouldUseWebShare } from '../shareTarget.js';
import { quoteDisplayName } from '../../lib/quoteNaming.js';
import type { Quote, Customer } from '../../types/domain.ts';

/**
 * Download name / document title for an exported quote: client name + quote
 * number (the shared `quoteDisplayName` convention), sanitised for the
 * filesystem. Used both as the download filename AND (via Document title) as
 * the PDF's embedded title. The public share link slugs the SAME convention
 * into its URL, so the file and the link always read the same.
 */
export function quoteFileName(quote: Quote, customer: Customer | null): string {
  return quoteDisplayName(quote, customer)
    .replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Hand the generated PDF blob to the user. Unchanged from the legacy
 * pipeline — the renderer swap (pdf-lib → react-pdf) doesn't touch delivery:
 *
 *   1. Web Share with files — iOS PWA / touch (gated by shouldUseWebShare).
 *   2. `<a download>` synthetic click — desktop and everywhere else.
 *   3. Last-resort navigate to the blob URL.
 *
 * The blob URL is held 30 s before revocation so slow devices finish reading.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (!blob || !blob.size) {
    throw new Error('El PDF generado está vacío; revisa que la cotización tenga datos.');
  }

  const prefersWebShare = shouldUseWebShare();
  if (prefersWebShare && typeof File !== 'undefined' && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      if (err && (err as DOMException).name === 'AbortError') return;
      console.warn('[quotePdf] navigator.share fell through:', err);
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    try { a.click(); } finally { document.body.removeChild(a); }
  } catch (err) {
    console.warn('[quotePdf] anchor click failed, navigating to blob:', err);
    window.location.href = url;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/**
 * Send the generated PDF straight to the printer — for the dealer who wants
 * paper, not a file in the downloads tray. Loads the blob in an off-screen,
 * same-origin iframe (a blob: URL inherits our origin, so we can reach its
 * window) and invokes the browser's own print dialog on it. If the frame can't
 * be printed (some browsers block print() on a PDF frame), falls back to opening
 * the PDF in a tab where the viewer's print button is one click away. The iframe
 * + blob URL are held ~60 s so the spooled job finishes before teardown.
 */
export async function printBlob(blob: Blob): Promise<void> {
  if (!blob || !blob.size) {
    throw new Error('El PDF generado está vacío; revisa que la cotización tenga datos.');
  }
  const url = URL.createObjectURL(blob);
  let iframe: HTMLIFrameElement | null = null;
  const teardown = () => setTimeout(() => {
    try { if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch { /* gone already */ }
    URL.revokeObjectURL(url);
  }, 60_000);

  try {
    iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    await new Promise<void>((resolve, reject) => {
      iframe!.onload = () => resolve();
      iframe!.onerror = () => reject(new Error('iframe load failed'));
      iframe!.src = url;
      document.body.appendChild(iframe!);
    });
    // Give the PDF viewer a beat to lay the document out before we print it.
    await new Promise((r) => setTimeout(r, 300));
    const win = iframe.contentWindow;
    if (!win) throw new Error('no print window');
    win.focus();
    win.print();
    teardown();
  } catch (err) {
    console.warn('[quotePdf] iframe print fell through, opening in a tab:', err);
    teardown();
    // Async generation can outlive the click gesture, so window.open may be
    // blocked — last resort is navigating the current tab to the PDF viewer.
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) window.location.href = url;
  }
}
