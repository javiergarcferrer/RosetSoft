import { canPrintPdfInIframe } from './shareTarget.js';

/**
 * Print a generated PDF — reliably, including on Safari.
 *
 * The hard part is Safari/WebKit: it treats a blob: PDF loaded into a hidden
 * iframe as a *download*, so the classic "print from an off-screen iframe"
 * trick silently saves the file instead of printing (exactly what the dealer
 * sees on a Mac). The fix is to print Safari from a real tab — but a tab opened
 * after the async PDF build is blocked by the popup blocker, because the user
 * gesture is already gone.
 *
 * So this is split in two: open the session SYNCHRONOUSLY inside the click
 * handler (before generating the PDF) — that opens the Safari print tab while
 * the gesture is still live — then `run(blob, mod)` once the blob is ready.
 *
 *   const session = openPrintSession('Generando factura…'); // sync, in the click
 *   if (session.blocked) { …tell the user to allow popups… return; }
 *   try {
 *     const mod  = await safeDynamicImport(() => import('…/pdf/…/index.js'));
 *     const blob = await mod.generateSomethingPdf(…);
 *     await session.run(blob, mod);   // mod provides printBlob + printInWindow
 *   } catch (e) { session.cancel(); … }
 *
 * Chrome / Edge / Firefox keep the off-screen iframe path (no tab opened).
 * `mod` is the dynamically-imported PDF module, which re-exports `printBlob`
 * and `printInWindow` from the delivery layer.
 */
export function openPrintSession(loadingLabel = 'Generando PDF…') {
  const useIframe = canPrintPdfInIframe();
  const win = useIframe ? null : window.open('', '_blank');
  if (win) {
    win.document.write(
      `<title>Imprimiendo…</title><p style="font:14px system-ui,sans-serif;padding:1rem;color:#555">${loadingLabel}</p>`,
    );
  }
  return {
    // Safari with popups blocked: we couldn't open the tab, so the caller
    // should surface a "permite ventanas emergentes" hint instead of silently
    // falling back to a download.
    blocked: !useIframe && !win,
    async run(blob, mod) {
      if (win) mod.printInWindow(win, blob);
      else await mod.printBlob(blob);
    },
    cancel() {
      try { if (win && !win.closed) win.close(); } catch { /* already gone */ }
    },
  };
}
