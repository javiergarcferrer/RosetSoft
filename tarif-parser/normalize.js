// Shared key-derivation helpers. The ONLY allowed key normalization in this
// parser. Do not inline `.trim().toLowerCase()` anywhere else.

import { createHash } from 'node:crypto';

// Combining diacritics range U+0300..U+036F.
const DIACRITICS = /[̀-ͯ]/g;
// Punctuation we collapse to space: parens, middle-dot, ASCII/en/em dashes,
// common terminators, both quote marks, and non-breaking space.
const PUNCT = /[()·\-–—.,;:'" ]+/g;
const WS = /\s+/g;

export function normalizeKey(s) {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(PUNCT, ' ')
    .replace(WS, ' ')
    .trim();
}

export function normalizeRef(s) {
  if (!s) return '';
  return s.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function sha1(s) {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

export function shortId(s) {
  return sha1(s).slice(0, 12);
}
