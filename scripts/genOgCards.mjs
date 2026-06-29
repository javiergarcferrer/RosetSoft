// Reproducible generator for the per-link WhatsApp/iMessage preview cards.
//
// The app is a hash-routed SPA, so a crawler (WhatsApp/Meta/iMessage) only ever
// reads the static HTML head of whatever real path it fetches — everything after
// `#` is stripped. To give each KIND of link a distinct preview we serve a small
// static launcher page per type (public/p/<type>.html), each with its own
// og:image. This script renders those images.
//
// Why render with headless Chromium instead of shipping a design-tool export:
//  - It pins the design in code (re-run to regenerate; no opaque binary to trust).
//  - Chromium's JPEG screenshot encoder writes a BASELINE jpeg — WhatsApp renders
//    progressive JPEGs as garbled noise (tests/ogImage.test.js pins this), and a
//    design-tool re-export silently flips to progressive.
//
// Run: node scripts/genOgCards.mjs
// Output: public/og-<type>-v1.jpg  (1200x630, baseline, < 600 KB)
//
// Bump the version suffix (…-v2) when you re-render: WhatsApp caches the card
// per image URL for weeks, so a fix only lands under a NEW filename — and the
// launcher page + ogImage.test.js must point at the same new name.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FONTS = join(ROOT, 'public', 'fonts');
const OUT = join(ROOT, 'public');

const CHROME =
  process.env.CHROME_BIN ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const b64 = (p) => readFileSync(p).toString('base64');
const HEAVY = b64(join(FONTS, 'Lausanne-700.woff2'));
const MID = b64(join(FONTS, 'Lausanne-500.woff2'));

// One card per shareable link KIND. The quote/propuesta card (og-card-v2.jpg)
// predates this set and is intentionally NOT regenerated here — it is pinned by
// the Meta link cache and the WhatsApp template button base; leave it be.
const CARDS = [
  {
    file: 'og-contrato-v2.jpg',
    accent: '#19A06B', // emerald — agreement / money
    glow: 'rgba(25,160,107,0.30)',
    head: 'Su plan de pago,',
    line: 'claro y firmable.',
    sub: 'Revíselo y fírmelo en línea.',
  },
  {
    file: 'og-togo-v2.jpg',
    accent: '#C76B29', // ALCOVER terracotta (current brand)
    glow: 'rgba(199,107,41,0.34)',
    head: 'Diseñe su Togo',
    line: 'a su medida.',
    sub: 'Combine módulos y telas en vivo.',
  },
  {
    file: 'og-tienda-v2.jpg',
    accent: '#5B5BD6', // indigo
    glow: 'rgba(91,91,214,0.32)',
    head: 'La colección ALCOVER,',
    line: 'disponible ahora.',
    sub: 'Explore la tienda en línea.',
  },
  {
    file: 'og-cuenta-v2.jpg',
    accent: '#2F6BF0', // blue
    glow: 'rgba(47,107,240,0.30)',
    head: 'Su estado de cuenta,',
    line: 'al día.',
    sub: 'Saldos, cargos y pagos en un lugar.',
  },
];

const html = (c) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Lausanne;font-weight:700;src:url(data:font/woff2;base64,${HEAVY}) format('woff2')}
@font-face{font-family:Lausanne;font-weight:500;src:url(data:font/woff2;base64,${MID}) format('woff2')}
*{margin:0;padding:0;box-sizing:border-box}
/* Paint the dark base on html/body too: a JPEG has no alpha, so any region the
   card doesn't cover would otherwise flush to BLACK and read as a hard strip
   (it clipped the wordmark in the first cut). position:fixed + inset:0 pins the
   card to the exact 1200x630 viewport so it always fills, edge to edge. */
html,body{width:1200px;height:630px;background:#100f0d}
.card{position:fixed;inset:0;overflow:hidden;
  background:#100f0d;font-family:Lausanne,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;
  background:radial-gradient(900px 520px at 88% 12%, ${c.glow}, transparent 60%),
             radial-gradient(700px 700px at 8% 108%, rgba(255,255,255,0.05), transparent 60%);}
.grain{position:absolute;inset:0;opacity:0.05;
  background-image:linear-gradient(rgba(255,255,255,.6) 1px,transparent 1px);background-size:100% 3px}
.body{position:absolute;left:96px;top:150px;right:80px}
.rule{position:absolute;left:96px;top:150px;width:6px;height:210px;border-radius:3px;background:${c.accent}}
.head{margin-left:36px;font-weight:700;font-size:78px;line-height:1.04;letter-spacing:-1.5px;color:#fbfaf8}
.line{margin-left:36px;font-weight:700;font-size:78px;line-height:1.04;letter-spacing:-1.5px;color:${c.accent}}
.sub{margin-left:36px;margin-top:30px;display:flex;align-items:center;gap:18px;
  font-weight:500;font-size:31px;letter-spacing:-0.2px;color:#cfccc4}
.dot{width:15px;height:15px;border-radius:50%;background:${c.accent};flex:none}
.mark{position:absolute;left:96px;bottom:78px;font-weight:700;font-size:60px;
  letter-spacing:3px;color:#fbfaf8}
</style></head><body><div class="card">
  <div class="glow"></div><div class="grain"></div>
  <div class="rule"></div>
  <div class="body">
    <div class="head">${c.head}</div>
    <div class="line">${c.line}</div>
    <div class="sub"><span class="dot"></span><span>${c.sub}</span></div>
  </div>
  <div class="mark">ALCOVER</div>
</div></body></html>`;

const tmp = mkdtempSync(join(tmpdir(), 'ogcards-'));
for (const c of CARDS) {
  const htmlPath = join(tmp, c.file.replace(/\.jpg$/, '.html'));
  const outPath = join(OUT, c.file);
  writeFileSync(htmlPath, html(c));
  execFileSync(
    CHROME,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--window-size=1200,630',
      `--screenshot=${outPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const size = readFileSync(outPath).length;
  console.log(`${c.file}  ${(size / 1024).toFixed(0)} KB`);
}
console.log('done');
