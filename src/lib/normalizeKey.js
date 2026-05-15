/**
 * Shared key normalizer for catalog dedup + importer reference lookup.
 *
 * Real-world data has a tonne of invisible variation that defeats the
 * naive `trim().toLowerCase()` / `trim().toUpperCase()` we were doing:
 *
 *   - NBSP ( ), narrow-NBSP ( ), zero-width-space (​),
 *     en/em spaces ( – )
 *   - Half-width vs. full-width punctuation ("ABANDON" vs "ＡＢＡＮＤＯＮ")
 *   - Combining accents ("ABANDÓN" stored either as `Ó` U+00D3 or
 *     as `O` + combining-acute U+0301)
 *   - Mixed-case + stray trailing spaces
 *   - References pasted with surrounding punctuation/parens
 *
 * Pipeline (order matters):
 *
 *   1. NFKC fold first — collapses compatibility variants
 *      (full-width → half-width, ligatures → base letters, NBSPs → space)
 *   2. NFD + strip combining marks (U+0300..U+036F) — removes accents
 *   3. toLocaleLowerCase() — case-fold
 *   4. (optional) strip punctuation / collapse whitespace per mode
 *
 * NFKC BEFORE NFD is deliberate: NFKC may emit precomposed accented
 * forms that NFD then decomposes cleanly. The reverse order leaves some
 * compatibility composites unhandled.
 *
 * Two modes:
 *
 *   normalizeKey(s, 'name') — for human-readable strings (product names,
 *     designer names). Strips a small set of noise punctuation that
 *     appears in our data (`()·-—.`) but keeps alphanumerics and inner
 *     spaces. Internal whitespace runs collapse to a single space.
 *
 *   normalizeKey(s, 'ref') — for catalog reference codes (e.g.
 *     `0P50FX1N`). Strips ALL whitespace and ALL non-alphanumeric
 *     characters. "0P50FX1N", "0P50FX1N ", "0P50FX1N ",
 *     "0p50fx1n", and "(0P50FX1N)" all collapse to the same key.
 *
 * Both modes return '' for empty / whitespace-only / null / undefined
 * input so the caller can early-out.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;
const NAME_NOISE = /[()·\-—.,]/g;
const REF_NOISE = /[^a-z0-9]/g;
const WS_RUN = /\s+/g;

export function normalizeKey(s, mode = 'name') {
  if (s == null) return '';
  let out = String(s);
  if (!out) return '';

  // 1. NFKC fold
  out = out.normalize('NFKC');
  // 2. NFD decompose + strip combining marks (accent fold)
  out = out.normalize('NFD').replace(COMBINING_MARKS, '');
  // 3. Lowercase (locale-aware so Turkic dotless-i etc. behave)
  out = out.toLocaleLowerCase();

  if (mode === 'ref') {
    // Strip everything that isn't [a-z0-9].
    out = out.replace(REF_NOISE, '');
    return out;
  }

  // name mode: strip noise punctuation, collapse whitespace, trim.
  out = out.replace(NAME_NOISE, ' ');
  out = out.replace(WS_RUN, ' ').trim();
  return out;
}
