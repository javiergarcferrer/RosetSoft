import type { PDFPage, PDFFont, RGB, PDFPageDrawTextOptions } from 'pdf-lib';
import type { CurrencyCode, RatesMap } from '../types/domain.ts';
import { INK } from './constants.js';

// ---------------------------------------------------------------------------
// Rounded-rectangle primitive. pdf-lib's drawRectangle has no border-radius,
// so we synthesize a rounded rect as an SVG path and fill/stroke it with
// drawSvgPath. The path is authored in SVG space (origin top-left, y DOWN);
// drawSvgPath places that origin at {x,y} and flips y, so passing the box's
// TOP-LEFT in PDF coords (x = left, y = topY) yields a box occupying
// [topY − h, topY]. `corners` lets a band round only its top or bottom pair,
// so a header (rounded top) and a footer (rounded bottom) bracket a group's
// member rows into one rounded card — the rounded silhouette the on-screen
// client link uses. Verified against pdftoppm before relying on it.
export interface Corners { tl?: number; tr?: number; br?: number; bl?: number; }
function roundedRectPath(w: number, h: number, c: Corners): string {
  const cap = Math.min(w / 2, h / 2);
  const tl = Math.max(0, Math.min(c.tl ?? 0, cap));
  const tr = Math.max(0, Math.min(c.tr ?? 0, cap));
  const br = Math.max(0, Math.min(c.br ?? 0, cap));
  const bl = Math.max(0, Math.min(c.bl ?? 0, cap));
  return [
    `M ${tl} 0`,
    `H ${w - tr}`, tr ? `A ${tr} ${tr} 0 0 1 ${w} ${tr}` : `L ${w} 0`,
    `V ${h - br}`, br ? `A ${br} ${br} 0 0 1 ${w - br} ${h}` : `L ${w} ${h}`,
    `H ${bl}`, bl ? `A ${bl} ${bl} 0 0 1 0 ${h - bl}` : `L 0 ${h}`,
    `V ${tl}`, tl ? `A ${tl} ${tl} 0 0 1 ${tl} 0` : `L 0 0`,
    'Z',
  ].join(' ');
}
export interface RoundedRectStyle {
  color?: RGB; borderColor?: RGB; borderWidth?: number;
  opacity?: number; radius?: number; corners?: Corners;
}
export function drawRoundedRect(
  page: PDFPage, x: number, topY: number, w: number, h: number, s: RoundedRectStyle,
): void {
  const r = s.radius ?? 0;
  const corners = s.corners ?? { tl: r, tr: r, br: r, bl: r };
  page.drawSvgPath(roundedRectPath(w, h, corners), {
    x, y: topY,
    color: s.color,
    borderColor: s.borderColor,
    borderWidth: s.borderWidth,
    opacity: s.opacity,
  });
}

/**
 * pdf-lib v1.x's `PDFPageDrawTextOptions` type omits `characterSpacing`,
 * but the runtime accepts and threads it through to the underlying PDF
 * operator. We pass it for the wide-tracked eyebrow labels ("CANTIDAD"
 * at 1.4pt tracking) where letter spacing is structural. This local
 * type widening keeps the typecheck honest without changing runtime
 * behavior — the option is forwarded as-is.
 */
export type DrawTextOptions = PDFPageDrawTextOptions & { characterSpacing?: number };

/**
 * Draw `text` such that its right edge sits at `rightX`. When
 * `characterSpacing` is non-zero we have to add the per-gap spacing to
 * the measured width — pdf-lib's `widthOfTextAtSize` doesn't know about
 * tracking, so a wide-tracked eyebrow ("CANTIDAD" at 1.4pt tracking)
 * would render shifted left and unbalanced without this correction.
 */
export function drawRightAt(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  size: number,
  font: PDFFont,
  color?: RGB | null,
  characterSpacing: number = 0,
): void {
  const baseW = font.widthOfTextAtSize(text, size);
  const trackingW = characterSpacing * Math.max(0, text.length - 1);
  const w = baseW + trackingW;
  page.drawText(text, {
    x: rightX - w, y, size, font, color: color || INK, characterSpacing,
  } as DrawTextOptions);
}

/**
 * Greedy word-wrap into lines of approximately `perLine` characters. We bound
 * on character count rather than measured width because terms text is mostly
 * Latin script at a fixed point size where the two are close enough — and
 * measuring per-line via the embedded font costs an order of magnitude more
 * work than a 95-character cap would save.
 */
export function wrapText(text: string | null | undefined, perLine: number): string[] {
  const words = (text || '').split(/\s+/);
  const out: string[] = [];
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
export function formatMoney(
  value: number | null | undefined,
  code: CurrencyCode,
  rates: RatesMap | null | undefined,
): string {
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

export function formatPlain(value: number | null | undefined): string {
  if (value == null) return '—';
  if (!Number.isFinite(value)) {
    console.warn('[quotePdf] formatPlain got non-finite value', { value });
    return '—';
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(value));
}
