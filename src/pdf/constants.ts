import { rgb } from 'pdf-lib';
import type { RGB } from 'pdf-lib';

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

// Tuned to mirror the app's ink palette + brand accent
export const INK:       RGB = rgb(0.09, 0.085, 0.07);   // ink-900
export const INK_HIGH:  RGB = rgb(0.23, 0.22, 0.19);    // ink-800
export const INK_MID:   RGB = rgb(0.42, 0.40, 0.36);    // ink-500
export const INK_SOFT:  RGB = rgb(0.66, 0.64, 0.59);    // ink-400
export const INK_LINE:  RGB = rgb(0.91, 0.90, 0.88);    // ink-100
export const INK_LINE2: RGB = rgb(0.82, 0.81, 0.78);    // ink-200
export const BG_SOFT:   RGB = rgb(0.97, 0.965, 0.96);   // ink-50
export const ACCENT:    RGB = rgb(0.78, 0.42, 0.16);    // brand-500

// Brand-700 — used for the eyebrow labels that read as terracotta in the
// client preview: section headers ("MOBILIARIO DE SALA"), the family
// chip ("KOBOLD") and the numeric-stack labels ("CANTIDAD" / "UNITARIO"
// / "TOTAL"). Slightly deeper than ACCENT so it still reads at body-text
// sizes against the white page.
export const BRAND_700: RGB = rgb(0.49, 0.24, 0.11);    // brand-700 #7d3e1c

// Lighter brand shade used for the vertical accent that runs down the
// left edge of an alternative-group row — same role the brand-300
// solid border plays in ClientPreview.jsx. Slightly desaturated so
// the bar reads as a marker, not another typographic element.
export const BRAND_300: RGB = rgb(0.91, 0.65, 0.43);    // brand-300 #e8a76d
export const EMERALD_700: RGB = rgb(0.02, 0.42, 0.27);  // matches the "seleccionada" callout
