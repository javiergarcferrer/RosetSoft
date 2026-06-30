// The WhatsApp/iMessage link-preview images must stay BASELINE jpegs:
// WhatsApp renders progressive JPEGs as garbled noise in the preview card
// (observed in production, 2026-06-12). A re-export from a design tool
// defaults to progressive easily — this pins the encoding, the size budget
// (WhatsApp skips images much over ~600 KB) and that each surface points at a
// file that actually exists.
//
// The app is a hash-routed SPA, so a crawler only reads the static head of the
// real path it fetches. The QUOTE card lives in index.html; every OTHER shared
// link (payment plan, configurator, tienda, estado de cuenta) is served its own
// card through a static launcher page under public/p/* — see public/p/*.html
// and scripts/genOgCards.mjs. This file pins all of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = (p) => new URL(`../${p}`, import.meta.url);

// Every link-preview image: the quote card (referenced by index.html) plus one
// per launcher. `launcher` is the static page that carries it (null = index.html).
const CARDS = [
  { img: 'public/og-card-v2.jpg', launcher: null },
  { img: 'public/og-contrato-v6.jpg', launcher: 'public/p/contrato.html', hash: '#/contrato/' },
  { img: 'public/og-togo-v6.jpg', launcher: 'public/p/togo.html', hash: 'configurator' },
  { img: 'public/og-tienda-v6.jpg', launcher: 'public/p/tienda.html', hash: '#/tienda' },
  { img: 'public/og-cuenta-v6.jpg', launcher: 'public/p/cuenta.html', hash: '#/cuenta/' },
];

function assertBaselineJpeg(bytes, label) {
  assert.equal(bytes[0], 0xff, `${label}: missing SOI`);
  assert.equal(bytes[1], 0xd8, `${label}: not a JPEG (missing SOI marker)`);
  // Scan the marker stream: SOF0 (0xC0, baseline) must appear; SOF2 (0xC2,
  // progressive) must not.
  let sof0 = false;
  let sof2 = false;
  for (let i = 2; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0xff) continue;
    const m = bytes[i + 1];
    if (m === 0xc0) sof0 = true;
    if (m === 0xc2) sof2 = true;
    if (m === 0xda) break; // start of scan — markers of interest are before it
  }
  assert.ok(sof0, `${label}: expected a baseline SOF0 frame`);
  assert.ok(!sof2, `${label}: progressive SOF2 frame found — WhatsApp garbles these`);
}

for (const { img } of CARDS) {
  test(`${img} is a baseline (non-progressive) JPEG`, () => {
    assertBaselineJpeg(readFileSync(root(img)), img);
  });

  test(`${img} stays inside WhatsApp size limits`, () => {
    const bytes = readFileSync(root(img));
    assert.ok(bytes.length <= 600 * 1024, `${img} is ${bytes.length} bytes (> 600 KB)`);
  });
}

test('index.html references the quote og image that exists', () => {
  const html = readFileSync(root('index.html'), 'utf8');
  assert.match(html, /og:image" content="%VITE_PUBLIC_ORIGIN%\/og-card-v2\.jpg"/);
  // No tag may still POINT at an old name (the comment may mention it).
  assert.ok(!/content="[^"]*og-claro/.test(html), 'a meta tag still points at og-claro.jpg');
  assert.ok(!/content="[^"]*\/og-card\.jpg"/.test(html), 'a meta tag still points at the un-versioned og-card.jpg');
  // No og:url canonical: Meta's crawler keys its cached link object by the
  // canonical, so one stale object would swallow every quote link again.
  assert.ok(!/property="og:url"/.test(html), 'og:url canonical collapses the preview cache — keep it out');
});

for (const { img, launcher, hash } of CARDS) {
  if (!launcher) continue;
  const name = img.replace('public/', '');
  test(`${launcher} carries its own card and forwards into the SPA`, () => {
    const html = readFileSync(root(launcher), 'utf8');
    // Points at ITS image, by its exact (versioned) filename, through the
    // %VITE_PUBLIC_ORIGIN% placeholder the build substitutes — so the image
    // resolves to the SAME host that serves the page (never the www marketing
    // site, which 404s these and collapses the card to text-only).
    const re = new RegExp(`og:image" content="%VITE_PUBLIC_ORIGIN%/${name.replace('.', '\\.')}"`);
    assert.match(html, re, `${launcher}: og:image must be %VITE_PUBLIC_ORIGIN%/${name}`);
    assert.ok(
      !/og:image" content="https?:\/\//.test(html),
      `${launcher}: og:image must use %VITE_PUBLIC_ORIGIN% (a hardcoded host like www 404s the image)`,
    );
    // Same canonical trap as index.html — keep og:url OUT.
    assert.ok(!/property="og:url"/.test(html), `${launcher}: og:url collapses the preview cache — keep it out`);
    // A human (JS) is forwarded into the matching SPA hash route.
    assert.ok(
      html.includes(`location.replace('/${hash}`),
      `${launcher}: must forward to ${hash}`,
    );
  });
}
