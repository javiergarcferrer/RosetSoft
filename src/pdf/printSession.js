/**
 * Print a generated PDF — reliably, on every browser, without ever downloading.
 *
 * The trap this avoids: the classic "print from a hidden, off-screen iframe"
 * trick is silently a *download* on the two engines that matter on a Mac —
 * Chrome's PDF plugin refuses to instantiate inside an iframe and falls back to
 * saving the blob, and Safari/WebKit treats a blob: PDF in an iframe as a
 * download outright. Either way the dealer taps "Imprimir" and gets a file in
 * the downloads tray instead of the print dialog.
 *
 * The fix is to print from a REAL top-level tab, where every modern browser
 * renders a blob: PDF inline in its built-in viewer and `print()` has a laid-out
 * document to capture. But a tab opened *after* the async PDF build is killed by
 * the popup blocker, because the user gesture is already spent.
 *
 * So this is split in two: open the tab SYNCHRONOUSLY inside the click handler
 * (before generating the PDF) — while the gesture is still live — then
 * `run(blob, mod)` points it at the finished PDF and fires print.
 *
 *   const session = openPrintSession('Generando factura…'); // sync, in the click
 *   if (session.blocked) { …tell the user to allow popups… return; }
 *   try {
 *     const mod  = await safeDynamicImport(() => import('…/pdf/…/index.js'));
 *     const blob = await mod.generateSomethingPdf(…);
 *     await session.run(blob, mod);   // mod provides printInWindow
 *   } catch (e) { session.cancel(); … }
 *
 * `mod` is the dynamically-imported PDF module, which re-exports `printInWindow`
 * from the delivery layer.
 */
export function openPrintSession(loadingLabel = 'Generando PDF…') {
  // Always a real tab — same path on every engine. Opened here, inside the
  // click gesture, so the popup blocker treats it as user-initiated. We park a
  // tiny "generating…" note in it while the heavy PDF chunk loads and renders.
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(
      `<title>Imprimiendo…</title><p style="font:14px system-ui,sans-serif;padding:1rem;color:#555">${loadingLabel}</p>`,
    );
  }
  return {
    // Popups blocked: we couldn't open the tab, so the caller should surface a
    // "permite ventanas emergentes" hint instead of silently downloading.
    blocked: !win,
    run(blob, mod) {
      mod.printInWindow(win, blob);
    },
    cancel() {
      try { if (win && !win.closed) win.close(); } catch { /* already gone */ }
    },
  };
}
