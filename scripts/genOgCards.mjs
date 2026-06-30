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
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

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
    file: 'og-contrato-v8.jpg',
    accent: '#19A06B', // emerald — agreement / money
    glow: 'rgba(25,160,107,0.42)',
    head: 'Su plan de pago,',
    line: 'claro y firmable.',
    sub: 'Revíselo y fírmelo en línea.',
  },
  {
    file: 'og-togo-v8.jpg',
    accent: '#C76B29', // ALCOVER terracotta (current brand)
    glow: 'rgba(199,107,41,0.46)',
    head: 'Diseñe su Togo',
    line: 'a su medida.',
    sub: 'Combine módulos y telas en vivo.',
  },
  {
    file: 'og-tienda-v8.jpg',
    accent: '#5B5BD6', // indigo
    glow: 'rgba(91,91,214,0.44)',
    head: 'La colección ALCOVER,',
    line: 'disponible ahora.',
    sub: 'Explore la tienda en línea.',
  },
  {
    file: 'og-cuenta-v8.jpg',
    accent: '#2F6BF0', // blue
    glow: 'rgba(47,107,240,0.42)',
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
html,body{width:1200px;height:630px;background:#15110d}
/* A lit charcoal surface, NOT a black void: a lifted base gradient plus a large
   accent wash filling the upper-right and a faint light in the lower-left means
   the areas the text doesn't cover still read as an intentional gradient — no
   flat near-black "null space".
   The size MUST be explicit (width/height), NOT position:fixed;inset:0 — with a
   flex column the inset version sized the card to its CONTENT (~423px tall),
   leaving the body background showing as a ~200px dead band at the bottom (the
   bug behind every "dead space below ALCOVER"). Explicit 1200x630 fills the
   whole picture, so ALCOVER seats against the real bottom edge. */
.card{position:absolute;top:0;left:0;width:1200px;height:630px;overflow:hidden;
  display:flex;flex-direction:column;justify-content:space-between;padding:84px 90px 16px;
  background:linear-gradient(152deg,#1a1611 0%,#141009 58%,#11100c 100%);
  font-family:Lausanne,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(1300px 820px at 97% -6%, ${c.glow}, transparent 60%),
             radial-gradient(820px 600px at 2% 104%, rgba(255,255,255,0.05), transparent 58%)}
/* Flex column (justify-content:space-between on .card): the headline block is the
   top flex child, ALCOVER the bottom one — so the wordmark is seated hard against
   the bottom padding. Type runs LARGE so it stays readable after WhatsApp
   downscales the card to ~a third of its size in the chat. */
.top{position:relative;display:flex;gap:32px}
.rule{width:7px;border-radius:4px;background:${c.accent};flex:none}
.head{font-family:Sohne,system-ui,sans-serif;font-size:90px;line-height:1.04;letter-spacing:-2.2px;color:#fbfaf8}
.line{font-family:Sohne,system-ui,sans-serif;font-size:90px;line-height:1.04;letter-spacing:-2.2px;color:${c.accent}}
.sub{display:flex;align-items:center;gap:18px;margin-top:36px;
  font-family:Lausanne,system-ui,sans-serif;font-size:40px;letter-spacing:-0.3px;color:#cdcac2}
.dot{width:17px;height:17px;border-radius:50%;background:${c.accent};flex:none}
/* ALCOVER (Rauschen). line-height:1, no clip → full caps. The font carries a
   small (~0.22em) built-in descent below the baseline, so the card's 16px
   bottom padding lands the VISIBLE caps ~30px off the picture edge — a slight,
   even margin, no dead band beneath it. */
.mark{position:relative;font-family:Rauschen,system-ui,sans-serif;font-size:70px;
  line-height:1;letter-spacing:0.5px;color:#fbfaf8}
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

// Render via the DevTools Protocol (NOT chrome --screenshot). The one-shot
// --screenshot path renders with a layout viewport that doesn't match the
// 1200x630 output, so a strip at the bottom falls outside it and the body
// background shows through there as a dead band below the wordmark. CDP's
// Emulation.setDeviceMetricsOverride pins the viewport to EXACTLY 1200x630 and
// captureScreenshot with an explicit clip grabs exactly that region — pixel-exact,
// no viewport guesswork.
const tmp = mkdtempSync(join(tmpdir(), 'ogcards-'));
const PORT = 9444;
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--force-color-profile=srgb', `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

// Wait for the debugging endpoint, then open one reusable page tab.
let target;
for (let i = 0; i < 50; i++) {
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = tabs.find((t) => t.type === 'page');
    if (target) break;
  } catch { /* not up yet */ }
  await sleep(100);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const cdp = (method, params = {}) => new Promise((res) => {
  const id = ++msgId; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });

for (const c of CARDS) {
  const htmlPath = join(tmp, c.file.replace(/\.jpg$/, '.html'));
  writeFileSync(htmlPath, html(c));
  await cdp('Page.navigate', { url: `file://${htmlPath}` });
  await sleep(400); // load + data-URI fonts settle (they're inline, so fast)
  const { data } = await cdp('Page.captureScreenshot', {
    format: 'jpeg', quality: 90,
    clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 },
    captureBeyondViewport: true,
  });
  writeFileSync(join(OUT, c.file), Buffer.from(data, 'base64'));
  console.log(`${c.file}  ${(Buffer.from(data, 'base64').length / 1024).toFixed(0)} KB`);
}
ws.close();
chrome.kill();
console.log('done');
