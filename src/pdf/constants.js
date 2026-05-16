import { rgb } from 'pdf-lib';

/**
 * Page geometry and color palette for the quote PDF. Centralized so the
 * sub-renderers (header / lines / totals) share consistent measurements and
 * palette values rather than redefining magic numbers per file.
 */

// US Letter, portrait
export const PAGE_W = 612;       // 8.5"
export const PAGE_H = 792;       // 11"
export const MARGIN_L = 56;
export const MARGIN_R = 56;
export const MARGIN_T = 56;
export const MARGIN_B = 56;
export const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;

// A hair more than the rendered line-row height (60). Used to detect when
// the next row would clip the bottom margin so we page-break beforehand.
export const LINE_ROW_RESERVED = 64;

// Tuned to mirror the app's ink palette + brand accent
export const INK       = rgb(0.09, 0.085, 0.07);   // ink-900
export const INK_HIGH  = rgb(0.23, 0.22, 0.19);    // ink-800
export const INK_MID   = rgb(0.42, 0.40, 0.36);    // ink-500
export const INK_SOFT  = rgb(0.66, 0.64, 0.59);    // ink-400
export const INK_LINE  = rgb(0.91, 0.90, 0.88);    // ink-100
export const INK_LINE2 = rgb(0.82, 0.81, 0.78);    // ink-200
export const BG_SOFT   = rgb(0.97, 0.965, 0.96);   // ink-50
export const ACCENT    = rgb(0.78, 0.42, 0.16);    // brand-500
