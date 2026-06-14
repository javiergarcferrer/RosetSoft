// Pins the EXIF Orientation reader that gates the outgoing-photo re-encode.
// A portrait phone photo carries Orientation 6 (rotate 90° CW): the browser
// honors it in our inbox, but WhatsApp's Cloud API serves the raw pixels, so
// the customer sees it sideways unless we bake the rotation in before sending.
// If this parser mis-reads the tag we either skip a needed rotation (sideways
// photo) or needlessly re-encode an upright one — so the byte layout is pinned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readJpegOrientation } from '../src/lib/imageOrientation.js';

// Build a minimal JPEG: SOI + APP1/EXIF carrying a single Orientation tag, then
// EOI. `little` toggles the TIFF byte order so both endiannesses are covered.
function jpegWithOrientation(orientation, { little = true } = {}) {
  const bytes = [];
  const push16 = (v, le = false) => {
    if (le) bytes.push(v & 0xff, (v >> 8) & 0xff);
    else bytes.push((v >> 8) & 0xff, v & 0xff);
  };
  const push32 = (v, le = false) => {
    if (le) bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    else bytes.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  };

  push16(0xffd8); // SOI
  push16(0xffe1); // APP1 marker

  // TIFF block: header (8) + IFD0 [count(2) + one 12-byte entry + next-offset(4)]
  const tiff = [];
  const t16 = (v) => { if (little) { tiff.push(v & 0xff, (v >> 8) & 0xff); } else { tiff.push((v >> 8) & 0xff, v & 0xff); } };
  const t32 = (v) => { if (little) { tiff.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); } else { tiff.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); } };
  tiff.push(little ? 0x49 : 0x4d, little ? 0x49 : 0x4d); // 'II' or 'MM'
  t16(0x002a);  // TIFF magic
  t32(8);       // IFD0 right after the 8-byte header
  t16(1);       // one directory entry
  t16(0x0112);  // Orientation tag
  t16(3);       // type SHORT
  t32(1);       // count
  t16(orientation); // value (SHORT lives in the first 2 of 4 value bytes)
  tiff.push(0, 0); // pad the value field to 4 bytes
  t32(0);       // no next IFD

  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0" + TIFF
  push16(exif.length + 2, false); // APP1 length (big-endian, includes itself)
  bytes.push(...exif);
  push16(0xffd9); // EOI
  return new Uint8Array(bytes).buffer;
}

test('reads the orientation tag (little-endian, all 8 values)', () => {
  for (let o = 1; o <= 8; o++) {
    assert.equal(readJpegOrientation(jpegWithOrientation(o)), o);
  }
});

test('reads the orientation tag in big-endian (MM) files', () => {
  assert.equal(readJpegOrientation(jpegWithOrientation(6, { little: false })), 6);
  assert.equal(readJpegOrientation(jpegWithOrientation(8, { little: false })), 8);
});

test('defaults to 1 (upright) when there is no EXIF / not a JPEG', () => {
  // A JPEG with no APP1 segment.
  const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
  assert.equal(readJpegOrientation(plain), 1);
  // Not a JPEG at all.
  assert.equal(readJpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), 1);
  // Empty buffer.
  assert.equal(readJpegOrientation(new Uint8Array([]).buffer), 1);
});

test('clamps out-of-range tag values to 1', () => {
  assert.equal(readJpegOrientation(jpegWithOrientation(0)), 1);
  assert.equal(readJpegOrientation(jpegWithOrientation(99)), 1);
});
