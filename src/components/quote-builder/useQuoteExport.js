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

  // Mint (once) + copy a public interactive link for the client. The token is
  // generated on first share and persisted on the quote; `shareEnabled` lets a
  // later revoke flip it off without losing the URL.
  async function shareQuote() {
    if (sharing) return;
    setSharing(true);
    try {
      let token = quote.shareToken;
      if (!token || !quote.shareEnabled) {
        token = token || newShareToken();
        await updateQuote({ shareToken: token, shareEnabled: true });
      }
      // Slug the SAME "client - Cotizacion N" label the PDF uses into the URL,
      // so the link the dealer copies reads like the file it matches.
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
    } catch {
      setShareMsg('No se pudo crear el enlace para compartir.');
    } finally {
      setSharing(false);
    }
  }

  async function exportPdf() {
    if (exporting) return;   // de-bounce double-taps
    setExportError(null);
    setExporting(true);
    try {
      const customer = quote.customerId
        ? customers.find((c) => c.id === quote.customerId)
        : null;
      const professional = quote.professionalId
        ? professionals.find((p) => p.id === quote.professionalId)
        : null;
      const seller = quote.createdByUserId
        ? (profiles || []).find((p) => p.id === quote.createdByUserId)
        : null;
      // Totals are computed on demand here (not threaded in) so the export
      // path stays self-contained — the dealer pays the cost only on export.
      const totals = computeTotals(
        lines.filter(isPricedLine).map(lineForTotals),
        { marginPct: quote.marginPct, discountPct: quote.discountPct, shipping: quote.shipping },
      );
      const { generateQuotePdf, downloadBlob, quoteFileName } = await safeDynamicImport(
        () => import('../../pdf/react/index.js'),
      );
      // Pass *all* lines to the generator — including section breaks. The
      // generator's groupBySection() consumes them as headings; the earlier
      // filter that stripped sections out predates the PDF matching the
      // on-screen ClientPreview, where section headers ("MOBILIARIO DE SALA")
      // are part of the layout the customer sees in both places.
      const blob = await generateQuotePdf({ quote, settings, lines, totals, customer, professional, seller, quoteGroups: groups, families });
      if (!blob || !blob.size) {
        throw new Error('El PDF generado está vacío; revisa que la cotización tenga datos.');
      }
      const filename = `${quoteFileName(quote, customer)}.pdf`;
      // Deliver the file straight away. downloadBlob picks Web Share on the
      // surfaces that need it (iOS PWA / touch) and an <a download> anchor
      // everywhere else, so desktop just gets the file in the downloads tray.
      await downloadBlob(blob, filename);
    } catch (err) {
      console.error('[QuoteBuilder] exportPdf failed:', err);
      setExportError(err?.message || 'No se pudo generar el PDF.');
    } finally {
      setExporting(false);
    }
  }

  return {
    exporting, exportError, setExportError,
    sharing, shareMsg, setShareMsg, exportErrorRef,
    exportPdf, shareQuote,
  };
}
