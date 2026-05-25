import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';

/**
 * Vercel serverless function: turn a fully-rendered quote HTML document into
 * a vector PDF with headless Chromium (Playwright).
 *
 * Why a server function at all: the client already renders the polished
 * `ClientPreview` (the "Vista cliente" layout) in the browser, but a blob
 * built from `html2canvas` would be a fuzzy raster with no selectable text.
 * Driving real Chromium with `page.pdf()` gives crisp, vector, paginated
 * output that matches the on-screen preview exactly — and lets us name the
 * file ourselves (the client streams the response into a Blob and shares /
 * downloads it as "<Cliente> - Cotizacion <N>.pdf", sidestepping the
 * blob:-URL "unknown name" problem entirely).
 *
 * The client POSTs a self-contained HTML document (markup + a <base> tag +
 * <link>s to the app's already-deployed CSS/fonts + public Supabase image
 * URLs). Chromium fetches those public assets, lays the page out, prints.
 * No DB access or auth happens here — everything needed is in the payload.
 *
 * Chromium runs in-house via @sparticuz/chromium (no third-party render
 * service, no token, client/pricing data never leaves the deploy).
 */
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let html;
  let filename;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    html = body.html;
    filename = body.filename;
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  if (!html || typeof html !== 'string') {
    res.status(400).json({ error: 'Missing "html" in body' });
    return;
  }

  let browser;
  try {
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
    // Render with screen styles — ClientPreview has no print stylesheet, and
    // emulating screen keeps colors/backgrounds matching the on-screen twin.
    await page.emulateMedia({ media: 'screen' });
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 25_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '12mm', left: '8mm', right: '8mm' },
    });

    const safeName = (filename || 'cotizacion.pdf').replace(/[^\w\-. ]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.status(200).send(Buffer.from(pdf));
  } catch (err) {
    console.error('[api/quote-pdf] failed:', err);
    res.status(500).json({ error: err?.message || 'PDF generation failed' });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* the function is about to be reclaimed anyway */
      }
    }
  }
}
