/**
 * Should this device hand exported files to the native share sheet
 * (Web Share API with files) instead of downloading / previewing them?
 *
 * The intent is iOS PWA standalone mode (where `<a download>` is silently
 * ignored by Safari) plus native Android / iOS browsers. On those surfaces
 * sharing the actual PDF File posts a real document to WhatsApp; opening a
 * blob: preview tab and sharing *that* posts a useless "blob:https://…"
 * text message instead.
 *
 * Desktop Chrome / Edge on Windows expose the same API, but the Windows
 * share sheet routes fragilely (Adobe's "Create PDF" handler grabs the
 * share, then complains the file is empty mid-handoff), so we keep desktop
 * on the preview-tab / anchor-click path it has used reliably for years.
 *
 *   PWA standalone        — display-mode media query + iOS quirk
 *   Touch-primary devices — phones / tablets (pointer: coarse + hover: none,
 *                           so hovering touch laptops fall through to desktop)
 *
 * Lives in its own module (no pdf-lib import) so QuoteBuilder can call it
 * synchronously inside the export click gesture — before the heavy
 * quotePdf chunk is dynamically imported — to decide whether to open the
 * preview tab at all.
 */
export function shouldUseWebShare(): boolean {
  if (typeof window === 'undefined') return false;
  const mq = (q: string) => window.matchMedia?.(q).matches;
  const isStandalonePwa =
    mq('(display-mode: standalone)') ||
    // iOS Safari sets a non-standard `navigator.standalone` on PWAs.
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  // A phone / tablet: the primary pointer is coarse AND it can't hover.
  // The extra `(hover: none)` keeps Windows touch laptops and convertibles
  // — which report `pointer: coarse` but still expose a hovering
  // mouse/trackpad — on the desktop preview-tab path, away from the fragile
  // Windows share-sheet route (Adobe's "Create PDF" grabs the file and
  // reports it empty mid-handoff).
  const isTouchPrimary = mq('(pointer: coarse)') && mq('(hover: none)');
  return !!(isStandalonePwa || isTouchPrimary);
}

/**
 * Can this browser print a generated PDF by loading the blob into a hidden
 * iframe and calling `iframe.contentWindow.print()`?
 *
 * Chrome / Edge / Firefox render a `blob:` PDF inside an iframe and print it
 * fine. Safari/WebKit instead treats the iframe's blob PDF as a *download* —
 * so the "Imprimir" button silently saves the file instead of printing. On
 * that engine the caller must open a real tab (Safari's viewer renders the
 * PDF inline) and print from there. Returns false on Safari/WebKit.
 *
 * Lives here (no pdf-lib import) so the export gesture can branch synchronously
 * — opening the print tab *inside* the click, before the heavy PDF chunk loads,
 * so the popup blocker allows it.
 */
export function canPrintPdfInIframe(): boolean {
  if (typeof navigator === 'undefined') return true;
  const ua = navigator.userAgent;
  const isSafari =
    /^((?!chrome|chromium|crios|android|fxios|edg).)*safari/i.test(ua) ||
    /\b(iPad|iPhone|iPod)\b/.test(ua);
  return !isSafari;
}
