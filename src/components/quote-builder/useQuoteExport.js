import { useEffect, useRef, useState } from 'react';
import { computeTotals, lineForTotals } from '../../lib/pricing.js';
import { isPricedLine } from '../../lib/constants.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { shareLinkUrl, newShareToken } from '../../lib/quoteShare.js';
import { quoteSlug } from '../../lib/quoteNaming.js';

/**
 * PDF export + share-link logic for the quote editor, lifted out of the
 * Workspace component so the export UI (TotalsDock, the error/share banners)
 * stays thin and the side-effect flow lives in one testable place.
 *
 * Owns the export/share UI status (in-flight flags + the transient banners)
 * and the two self-contained effects that drive them (auto-dismiss the share
 * toast; scroll the error banner into view on mobile). The actual mutations
 * stay outside — `shareQuote` persists the token through the caller's
 * `updateQuote`, the single quote writer.
 *
 * @param {object}   deps
 * @param {object}   deps.quote          current quote (may be null while loading)
 * @param {object}   deps.settings       app settings (PDF branding, rates)
 * @param {Array}    deps.lines          quote lines
 * @param {Array}    deps.customers      profile customers (resolve quote.customerId)
 * @param {Array}    deps.professionals  profile professionals
 * @param {Array}    deps.profiles       user profiles (resolve the seller)
 * @param {Array}    deps.groups         quote groups (Conjuntos/Alternativas)
 * @param {Map}      deps.families       catalog families by SKU root
 * @param {Function} deps.updateQuote    the quote writer (persists the share token)
 */
export function useQuoteExport({
  quote, settings, lines, customers, professionals, profiles, groups, families, updateQuote,
}) {
  // PDF export UI state — disables the export button while a generation is in
  // flight, and surfaces failures (a malformed line, a refusal from the
  // browser to deliver the blob) instead of swallowing them.
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [exportError, setExportError] = useState(null);
  // Share-link state: a spinner while the token is minted/persisted, and a
  // transient toast confirming the copied link (or showing it to copy by
  // hand when the clipboard API is unavailable).
  const [sharing, setSharing] = useState(false);
  const [shareMsg, setShareMsg] = useState(null);
  useEffect(() => {
    if (!shareMsg) return undefined;
    const id = setTimeout(() => setShareMsg(null), 6000);
    return () => clearTimeout(id);
  }, [shareMsg]);
  // On mobile the only export trigger is the bottom sticky bar, but the error
  // banner renders at the top of the page — so a failed export would stop the
  // spinner with the explanation scrolled far out of sight, recreating the "I
  // tapped it and nothing happened" silence the banner exists to prevent.
  // Scroll the banner into view whenever it appears.
  const exportErrorRef = useRef(null);
  useEffect(() => {
    if (exportError) {
      exportErrorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }, [exportError]);

  // Send the quote DIRECTLY — never via the downloads tray. Builds the same PDF
  // the dealer would export and hands the actual File to the OS share sheet
  // (`navigator.share({files})`), so it goes straight to Mail / WhatsApp /
  // Messages / AirDrop. `canShare({files})` is the capability probe: it's true on
  // Safari (incl. macOS) and mobile; where it's false — notably desktop Chrome,
  // which can't share files — we fall back to copying the live interactive
  // client link (`shareClientLink`) so Share still does something useful.
  async function shareQuote() {
    if (sharing || exporting || printing) return;
    setSharing(true);
    setExportError(null);
    try {
      const { blob, filename } = await generatePdf();
      // Attach the real PDF file to the native share sheet when supported. The
      // gesture survives the async build (Web Share's transient-activation
      // window outlasts a render), the same way the iOS download path shares.
      if (typeof File !== 'undefined' && navigator.canShare) {
        const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: filename });
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') return; // user dismissed the sheet
            // Anything else (e.g. gesture lost) → fall through to the link copy.
            console.warn('[QuoteBuilder] share with file fell through:', err);
          }
        }
      }
      await shareClientLink();
    } catch (err) {
      console.error('[QuoteBuilder] shareQuote failed:', err);
      setExportError(err?.message || 'No se pudo compartir la cotización.');
    } finally {
      setSharing(false);
    }
  }

  // Fallback share: mint (once) + copy a public interactive link for the client.
  // The token is generated on first share and persisted on the quote;
  // `shareEnabled` lets a later revoke flip it off without losing the URL.
  async function shareClientLink() {
    let token = quote.shareToken;
    if (!token || !quote.shareEnabled) {
      token = token || newShareToken();
      await updateQuote({ shareToken: token, shareEnabled: true });
    }
    // Slug the SAME "client - Cotizacion N" label the PDF uses into the URL, so
    // the link the dealer copies reads like the file it matches.
    const customer = quote.customerId
      ? customers.find((c) => c.id === quote.customerId)
      : null;
    const url = shareLinkUrl(token, quoteSlug(quote, customer));
    try {
      await navigator.clipboard.writeText(url);
      setShareMsg(`Enlace copiado · ${url}`);
    } catch {
      setShareMsg(url);
    }
  }

  // Shared PDF build for both Export (download) and Print. Resolves the related
  // entities + totals on demand (so the path stays self-contained — the dealer
  // pays the cost only on export) and renders the blob; the caller decides how
  // to deliver it. Throws on an empty blob so both paths surface the same error.
  // Passes *all* lines to the generator — including section breaks, which its
  // groupBySection() consumes as headings (matching the on-screen ClientPreview).
  async function generatePdf() {
    const customer = quote.customerId
      ? customers.find((c) => c.id === quote.customerId)
      : null;
    const professional = quote.professionalId
      ? professionals.find((p) => p.id === quote.professionalId)
      : null;
    const seller = quote.createdByUserId
      ? (profiles || []).find((p) => p.id === quote.createdByUserId)
      : null;
    const totals = computeTotals(
      lines.filter(isPricedLine).map(lineForTotals),
      { marginPct: quote.marginPct, discountPct: quote.discountPct, courtesyDiscountPct: quote.courtesyDiscountPct, shipping: quote.shipping },
    );
    const mod = await safeDynamicImport(() => import('../../pdf/react/index.js'));
    const blob = await mod.generateQuotePdf({ quote, settings, lines, totals, customer, professional, seller, quoteGroups: groups, families });
    if (!blob || !blob.size) {
      throw new Error('El PDF generado está vacío; revisa que la cotización tenga datos.');
    }
    return { mod, blob, filename: `${mod.quoteFileName(quote, customer)}.pdf` };
  }

  async function exportPdf() {
    if (exporting || printing || sharing) return;   // de-bounce double-taps / concurrent gen
    setExportError(null);
    setExporting(true);
    try {
      const { mod, blob, filename } = await generatePdf();
      // downloadBlob picks Web Share on the surfaces that need it (iOS PWA /
      // touch) and an <a download> anchor everywhere else, so desktop just gets
      // the file in the downloads tray.
      await mod.downloadBlob(blob, filename);
    } catch (err) {
      console.error('[QuoteBuilder] exportPdf failed:', err);
      setExportError(err?.message || 'No se pudo generar el PDF.');
    } finally {
      setExporting(false);
    }
  }

  // Print directly — generate the same PDF the export ships and hand it to
  // the in-app print preview (PrintPdfModal), which rasterizes it and prints
  // via window.print() on OUR page. No tab, no blob navigation, no popup
  // blocker — a download is structurally impossible (the modal owns the
  // rationale). The Workspace renders the modal off `printDoc`.
  const [printDoc, setPrintDoc] = useState(null);   // { blob } | null
  async function printPdf() {
    if (exporting || printing || sharing) return;
    setExportError(null);
    setPrinting(true);
    try {
      const { blob } = await generatePdf();
      setPrintDoc({ blob });
    } catch (err) {
      console.error('[QuoteBuilder] printPdf failed:', err);
      setExportError(err?.message || 'No se pudo imprimir el PDF.');
    } finally {
      setPrinting(false);
    }
  }
  const closePrint = () => setPrintDoc(null);

  return {
    exporting, printing, exportError, setExportError,
    sharing, shareMsg, setShareMsg, exportErrorRef,
    exportPdf, printPdf, shareQuote,
    printDoc, closePrint,
  };
}
