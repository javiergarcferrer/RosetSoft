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
// Output: public/og-<type>-v<N>.jpg  (1200x630, baseline, < 600 KB)
//
// Bump the version suffix (…-vN) when you re-render: WhatsApp caches the card
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
// The ALCOVER brand type system, used exactly as everywhere else in the app:
//   headers  → Söhne (Halbfett)
//   body     → Lausanne
//   ALCOVER  → Rauschen  (the wordmark is ALWAYS set in Rauschen)
const SOHNE = b64(join(FONTS, 'Sohne-Halbfett.woff2'));
const LAUSANNE = b64(join(FONTS, 'Lausanne-500.woff2'));
const RAUSCHEN = b64(join(FONTS, 'RauschenB-Semibold.woff2'));

// One card per shareable link KIND. The quote/propuesta card (og-card-v2.jpg)
// predates this set and is intentionally NOT regenerated here — it is pinned by
// the Meta link cache and the WhatsApp template button base; leave it be.
const CARDS = [
  {
    file: 'og-contrato-v4.jpg',
    accent: '#19A06B', // emerald — agreement / money
    glow: 'rgba(25,160,107,0.30)',
    head: 'Su plan de pago,',
    line: 'claro y firmable.',
    sub: 'Revíselo y fírmelo en línea.',
  },
  {
    file: 'og-togo-v4.jpg',
    accent: '#C76B29', // ALCOVER terracotta (current brand)
    glow: 'rgba(199,107,41,0.34)',
    head: 'Diseñe su Togo',
    line: 'a su medida.',
    sub: 'Combine módulos y telas en vivo.',
  },
  {
    file: 'og-tienda-v4.jpg',
    accent: '#5B5BD6', // indigo
    glow: 'rgba(91,91,214,0.32)',
    head: 'La colección ALCOVER,',
    line: 'disponible ahora.',
    sub: 'Explore la tienda en línea.',
  },
  {
    file: 'og-cuenta-v4.jpg',
    accent: '#2F6BF0', // blue
    glow: 'rgba(47,107,240,0.30)',
    head: 'Su estado de cuenta,',
    line: 'al día.',
    sub: 'Saldos, cargos y pagos en un lugar.',
  },
];

const html = (c) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Sohne;src:url(data:font/woff2;base64,${SOHNE}) format('woff2')}
@font-face{font-family:Lausanne;src:url(data:font/woff2;base64,${LAUSANNE}) format('woff2')}
@font-face{font-family:Rauschen;src:url(data:font/woff2;base64,${RAUSCHEN}) format('woff2')}
*{margin:0;padding:0;box-sizing:border-box}
/* Paint the dark base on html/body too: a JPEG has no alpha, so any region the
   card doesn't cover would otherwise flush to BLACK and read as a hard strip.
   A full-bleed gradient (top to bottom) means there is NEVER a flat black band —
   the bottom is part of the same wash as the top. position:fixed + inset:0 pins
   the card to the exact 1200x630 viewport so it always fills, edge to edge. */
html,body{width:1200px;height:630px;background:#100f0d}
.card{position:fixed;inset:0;overflow:hidden;
  background:linear-gradient(157deg,#0c0b09 0%,#15120e 58%,#0f0e0c 100%);
  font-family:Lausanne,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(840px 520px at 87% 4%, ${c.glow}, transparent 62%)}
.top{position:absolute;left:96px;top:86px;right:80px;display:flex;gap:34px}
.rule{width:6px;border-radius:3px;background:${c.accent};flex:none}
.head{font-family:Sohne,system-ui,sans-serif;font-size:74px;line-height:1.06;letter-spacing:-1.6px;color:#fbfaf8}
.line{font-family:Sohne,system-ui,sans-serif;font-size:74px;line-height:1.06;letter-spacing:-1.6px;color:${c.accent}}
.sub{display:flex;align-items:center;gap:16px;margin-top:32px;
  font-family:Lausanne,system-ui,sans-serif;font-size:30px;letter-spacing:-0.2px;color:#cbc8c0}
.dot{width:14px;height:14px;border-radius:50%;background:${c.accent};flex:none}
/* ALCOVER (Rauschen) pinned to the bottom edge. Rauschen carries a tall built-in
   descent, so a normal line box would leave a fat empty band beneath the caps;
   line-height:0.72 crops the box down to ~cap height and overflow:hidden trims
   the residual descent, so the VISIBLE letters sit ~30px off the bottom edge. */
.mark{position:absolute;left:96px;bottom:34px;height:46px;overflow:hidden;
  font-family:Rauschen,system-ui,sans-serif;font-size:64px;line-height:0.72;
  letter-spacing:0.5px;color:#fbfaf8}
</style></head><body><div class="card">
  <div class="glow"></div>
  <div class="top">
    <div class="rule"></div>
    <div>
      <div class="head">${c.head}</div>
      <div class="line">${c.line}</div>
      <div class="sub"><span class="dot"></span><span>${c.sub}</span></div>
    </div>
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
