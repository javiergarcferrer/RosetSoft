import { createRoot } from 'react-dom/client';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';

/**
 * Server-rendered quote PDF: build a self-contained HTML document from the
 * SAME `ClientPreview` the dealer sees in "Vista cliente", then hand it to
 * the /api/quote-pdf function which prints it with headless Chromium.
 *
 * This is what makes the PDF finally match the on-screen preview — instead
 * of pdf-lib redrawing the layout by hand (which drifted from the HTML), we
 * reuse the actual component and let a real browser paginate it.
 *
 * The trick is reuse-without-re-render: we mount ClientPreview off-screen,
 * wait for its Supabase images to resolve, snapshot the markup, and ship it
 * alongside <link>s to the app's already-deployed CSS/fonts (resolved via a
 * <base> tag). Chromium re-fetches those public assets, so the payload stays
 * small and the styling is byte-identical to production.
 */

const A4_WIDTH_PX = 794; // A4 width at 96dpi — the page box we lay out into.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ClientPreview's <ImageView> resolves each image asynchronously (a Supabase
 * lookup, then a public URL), so the markup has empty <img> until they land.
 * Wait until the set of sourced images stops growing AND every one has
 * decoded — otherwise the snapshot ships blank product photos. Heuristic,
 * with a hard ceiling so a single stuck image can't hang the export.
 */
async function waitForImages(root, { timeout = 9000, settle = 500, minWait = 700 } = {}) {
  const start = Date.now();
  let lastCount = -1;
  let stableAt = Date.now();
  while (Date.now() - start < timeout) {
    const imgs = [...root.querySelectorAll('img')].filter((i) => i.getAttribute('src'));
    const count = imgs.length;
    const allComplete = imgs.every((i) => i.complete && i.naturalWidth > 0);
    if (count === lastCount && allComplete) {
      if (Date.now() - stableAt >= settle && Date.now() - start >= minWait) return;
    } else {
      lastCount = count;
      stableAt = Date.now();
    }
    await sleep(120);
  }
}

/**
 * The app's compiled CSS lives in <link>ed stylesheets in production (and in
 * injected <style> tags under `vite dev`). Carry both into the print doc so
 * Chromium renders with the exact Tailwind build. Cross-origin <link>s keep
 * their absolute href; relative ones (and the @font-face urls inside them)
 * resolve against the <base> tag we add to the head.
 */
function collectStyleTags() {
  const parts = [];
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    if (node.tagName === 'LINK') {
      if (node.href) parts.push(`<link rel="stylesheet" href="${node.href}">`);
    } else if (node.textContent) {
      parts.push(`<style>${node.textContent}</style>`);
    }
  }
  return parts.join('\n');
}

const PRINT_CSS = `
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: ${A4_WIDTH_PX}px; }
  .pdf-export-root { width: ${A4_WIDTH_PX}px; background: #fff; }
  /* On screen the preview floats as a card; on a printed page the card
     chrome (shadow / rounded corners / outer border) reads as noise, so
     flatten it to a full-bleed page. */
  .pdf-export-root > div { box-shadow: none !important; border-radius: 0 !important; border: 0 !important; }
  img { break-inside: avoid; }
`;

async function renderClientPreviewHtml(props) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${A4_WIDTH_PX}px;z-index:-1;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await new Promise((resolve) => {
      root.render(<ClientPreview {...props} />);
      // Two rAFs: one to commit the tree, one to let layout/images kick off.
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    await waitForImages(host);
    const inner = host.innerHTML;
    const styles = collectStyleTags();
    const base = `${window.location.origin}/`;
    return (
      `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
      `<base href="${base}">` +
      styles +
      `<style>${PRINT_CSS}</style>` +
      `</head><body><div class="pdf-export-root">${inner}</div></body></html>`
    );
  } finally {
    root.unmount();
    host.remove();
  }
}

/**
 * Render the quote to a vector PDF Blob via the Chromium print service.
 * Throws on any failure so the caller can fall back to the pdf-lib path.
 */
export async function generateQuotePdfViaServer(props, filename) {
  const html = await renderClientPreviewHtml(props);
  const res = await fetch('/api/quote-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, filename }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`El servicio de PDF respondió ${res.status}. ${detail.slice(0, 180)}`);
  }
  const blob = await res.blob();
  if (!blob || !blob.size || (blob.type && blob.type.includes('json'))) {
    throw new Error('El servicio de PDF devolvió una respuesta vacía o inválida.');
  }
  return blob;
}
