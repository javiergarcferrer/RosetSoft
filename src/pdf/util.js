import { INK } from './constants.js';

/**
 * Draw `text` such that its right edge sits at `rightX`. When
 * `characterSpacing` is non-zero we have to add the per-gap spacing to
 * the measured width — pdf-lib's `widthOfTextAtSize` doesn't know about
 * tracking, so a wide-tracked eyebrow ("CANTIDAD" at 1.4pt tracking)
 * would render shifted left and unbalanced without this correction.
 */
export function drawRightAt(page, text, rightX, y, size, font, color, characterSpacing = 0) {
  const baseW = font.widthOfTextAtSize(text, size);
  const trackingW = characterSpacing * Math.max(0, text.length - 1);
  const w = baseW + trackingW;
  page.drawText(text, {
    x: rightX - w, y, size, font, color: color || INK, characterSpacing,
  });
}

/** Cap a string at `n` characters with an ellipsis tail. */
export function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Greedy word-wrap into lines of approximately `perLine` characters. We bound
 * on character count rather than measured width because terms text is mostly
 * Latin script at a fixed point size where the two are close enough — and
 * measuring per-line via the embedded font costs an order of magnitude more
 * work than a 95-character cap would save.
 */
export function wrapText(text, perLine) {
  const words = (text || '').split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine) {
      out.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

// computeTotals() guarantees finite numbers, but if something upstream (a
// missing exchange rate, a corrupt variant payload, an arithmetic bug) sneaks
// a NaN/Infinity through, surface it loudly rather than rendering "—" with
// no diagnostic — a quote that ships with "—" in the total column is worse
// than one that fails to generate.
export function formatMoney(value, code, rates) {
  if (value == null) return '—';
  if (!Number.isFinite(value)) {
    console.warn('[quotePdf] formatMoney got non-finite value', { value, code });
    return '—';
  }
  const rate = rates?.[code] ?? 1;
  const v = value * rate;
  if (!Number.isFinite(v)) {
    console.warn('[quotePdf] formatMoney post-rate non-finite', { value, code, rate });
    return '—';
  }
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${code}`;
  }
}

export function formatPlain(value) {
  if (value == null) return '—';
  if (!Number.isFinite(value)) {
    console.warn('[quotePdf] formatPlain got non-finite value', { value });
    return '—';
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(value));
}
