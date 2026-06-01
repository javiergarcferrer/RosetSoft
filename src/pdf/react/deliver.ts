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
