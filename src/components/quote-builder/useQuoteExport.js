import { useEffect, useRef, useState } from 'react';
import {
  computeTotals, lineForTotals, companyDiscountPctFor, applyCompanyDiscount,
} from '../../lib/pricing.js';
import { isPricedLine } from '../../lib/constants.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';

/**
 * PDF export logic for the quote editor, lifted out of the Workspace component
 * so the export UI (TotalsDock, the error banner) stays thin and the
 * side-effect flow lives in one testable place.
 *
 * Owns the export UI status (in-flight flags + the error banner) and the
 * effect that scrolls the banner into view on mobile. Sharing the quote with
 * the client is NOT here — that goes through the WhatsApp Business API send
 * modal (SendQuoteModal), the single send surface, which mints the public link
 * itself; there is no OS share-sheet path that would bypass the dealer's
 * WhatsApp number.
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
 */
export function useQuoteExport({
  quote, settings, lines, customers, professionals, profiles, groups, families,
}) {
  // PDF export UI state — disables the export button while a generation is in
  // flight, and surfaces failures (a malformed line, a refusal from the
  // browser to deliver the blob) instead of swallowing them.
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [exportError, setExportError] = useState(null);
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
    // Company-account quote → the PDF order document is priced at dealer cost
    // (every product price scaled), so the per-line figures and the totals
    // match the on-screen client preview. A normal quote: pct 0, lines untouched.
    const companyPct = companyDiscountPctFor(quote, settings);
    const orderLines = companyPct ? applyCompanyDiscount(lines, companyPct) : lines;
    const totals = computeTotals(
      orderLines.filter(isPricedLine).map(lineForTotals),
      { marginPct: quote.marginPct, discountPct: quote.discountPct, courtesyDiscountPct: quote.courtesyDiscountPct, shipping: quote.shipping },
    );
    const mod = await safeDynamicImport(() => import('../../pdf/react/index.js'));
    const blob = await mod.generateQuotePdf({ quote, settings, lines: orderLines, totals, customer, professional, seller, quoteGroups: groups, families });
    if (!blob || !blob.size) {
      throw new Error('El PDF generado está vacío; revisa que la cotización tenga datos.');
    }
    return { mod, blob, filename: `${mod.quoteFileName(quote, customer)}.pdf` };
  }

  async function exportPdf() {
    if (exporting || printing) return;   // de-bounce double-taps / concurrent gen
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
    if (exporting || printing) return;
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
    exporting, printing, exportError, setExportError, exportErrorRef,
    exportPdf, printPdf,
    // The raw blob builder, for callers that deliver the PDF themselves
    // (the WhatsApp send modal ships it as a document via wa-send).
    generatePdf,
    printDoc, closePrint,
  };
}
