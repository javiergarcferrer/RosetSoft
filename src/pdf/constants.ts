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

// Violet shades for the Conjunto (set) treatment — the take-all twin of
// the alternative group. ClientPreview / LineItemList mark set members
// with a violet-300 solid left border + a violet-700 "Conjunto" eyebrow;
// these mirror those Tailwind tokens so the PDF reads the same as the
// on-screen preview. Distinct from the brand accent so a customer can
// tell "sold together" (violet) apart from "pick one" (brand).
export const VIOLET_300: RGB = rgb(0.77, 0.71, 0.97);   // violet-300 #c4b5fd
export const VIOLET_700: RGB = rgb(0.42, 0.24, 0.80);   // violet-700 #6d28d9

// Grand-total band — the headline of the "confident commercial" redesign.
// A solid near-black bar anchors the total; the label reads in a muted
// cream tone inside the band, the value in pure white. These two tones
// only ever appear inside the band, so they live here as band-specific
// palette entries rather than reusing the page ink scale.
export const BAND_INK:   RGB = rgb(0.07, 0.065, 0.055);  // band fill — ink-950, near black
export const BAND_CREAM: RGB = rgb(0.82, 0.79, 0.72);    // "TOTAL" label inside the band
export const WHITE:      RGB = rgb(1, 1, 1);

/**
 * Type scale — collapsed to ~6 roles for the "confident commercial"
 * redesign. Every draw* function maps onto one of these named sizes
 * instead of one-off magic numbers, so the hierarchy rebalances in one
 * place. Roles:
 *
 *   DISPLAY     company wordmark (header, left)
 *   NUMBER      quote # (header, right) — deliberately quieter than the total
 *   TOTAL_BIG   the grand-total value — the unmistakable visual climax
 *   TITLE       product name + customer name
 *   EYEBROW     section headers, CLIENTE/VENDEDOR labels, status captions
 *   BODY        descriptions, addresses, subtotal-stack rows
 *   META        ref/dim, FX shadow, footer
 *   EYEBROW_SM  family eyebrow, compact money-cell line
 */
export const FS_DISPLAY    = 22;
export const FS_NUMBER     = 15;
export const FS_TOTAL_BIG  = 24;
export const FS_TITLE      = 13;
export const FS_EYEBROW    = 11;
export const FS_BODY       = 9.5;
export const FS_META       = 8.5;
export const FS_EYEBROW_SM = 8;
