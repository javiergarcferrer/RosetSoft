/**
 * Tests for src/lib/instagramDm.js -- the Instagram Direct send helpers.
 *
 * Pins normalizeDmText: outgoing DM text must ride the wire in Unicode NFC so
 * accented letters send as a single precomposed code point. Decomposed input
 * (e.g. n-tilde as "n" + a combining tilde U+0303, which iOS keyboards /
 * dictation / paste can emit) renders a stray "extra tilde" in Instagram's
 * native app even though the browser shows it fine -- NFC collapses it back
 * into one glyph.
 *
 * Code points are written as \u escapes (ASCII-only source) so the test is
 * unambiguous regardless of how this file's own bytes get normalized on disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDmText } from '../src/lib/instagramDm.js';

const TILDE = '̃';   // combining tilde
const ACUTE = '́';   // combining acute accent
const N_TILDE = 'ñ'; // precomposed n-tilde
const I_ACUTE = 'í'; // precomposed i-acute
const A_ACUTE = 'á'; // precomposed a-acute

test('collapses a decomposed n-tilde (n + combining tilde) into one precomposed code point', () => {
  const decomposed = 'Sen' + TILDE + 'or';      // "Senor" with n + U+0303
  assert.equal(decomposed.length, 6);           // two code points for the n-tilde
  const out = normalizeDmText(decomposed);
  assert.equal(out, 'Se' + N_TILDE + 'or');     // single U+00F1
  assert.equal(out.length, 5);                  // one fewer: it collapsed
  assert.ok(!out.includes(TILDE));              // no stray combining tilde survives
});

test('leaves an already-precomposed n-tilde untouched and trims edges', () => {
  const precomposed = 'Se' + N_TILDE + 'or';
  assert.equal(normalizeDmText('  ' + precomposed + '  '), precomposed);
});

test('handles other decomposed accents (i-acute, a-acute) the same way', () => {
  assert.equal(normalizeDmText('envi' + ACUTE + 'os'), 'env' + I_ACUTE + 'os');
  assert.equal(normalizeDmText('a' + ACUTE), A_ACUTE);
});

test('null/undefined/empty are safe and yield an empty string', () => {
  assert.equal(normalizeDmText(null), '');
  assert.equal(normalizeDmText(undefined), '');
  assert.equal(normalizeDmText(''), '');
});
