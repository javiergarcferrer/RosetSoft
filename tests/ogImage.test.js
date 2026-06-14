// The WhatsApp/iMessage link-preview image must stay a BASELINE jpeg:
// WhatsApp renders progressive JPEGs as garbled noise in the preview card
// (observed in production, 2026-06-12). A re-export from a design tool
// defaults to progressive easily — this pins the encoding, the size budget
// (WhatsApp skips images much over ~600 KB) and that index.html points at
// the file that actually exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const OG_PATH = new URL('../public/og-card-v2.jpg', import.meta.url);

test('og image is a baseline (non-progressive) JPEG', () => {
  const bytes = readFileSync(OG_PATH);
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8, 'not a JPEG (missing SOI marker)');
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
  assert.ok(sof0, 'expected a baseline SOF0 frame');
  assert.ok(!sof2, 'progressive SOF2 frame found — WhatsApp garbles these');
});

test('og image stays inside WhatsApp size limits', () => {
  const bytes = readFileSync(OG_PATH);
  assert.ok(bytes.length <= 600 * 1024, `og image is ${bytes.length} bytes (> 600 KB)`);
});

test('index.html references the og image that exists', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /og:image" content="%VITE_PUBLIC_ORIGIN%\/og-card-v2\.jpg"/);
  // No tag may still POINT at an old name (the comment may mention it).
  assert.ok(!/content="[^"]*og-claro/.test(html), 'a meta tag still points at og-claro.jpg');
  assert.ok(!/content="[^"]*\/og-card\.jpg"/.test(html), 'a meta tag still points at the un-versioned og-card.jpg');
  // No og:url canonical: Meta's crawler keys its cached link object by the
  // canonical, so one stale object would swallow every quote link again.
  assert.ok(!/property="og:url"/.test(html), 'og:url canonical collapses the preview cache — keep it out');
});
