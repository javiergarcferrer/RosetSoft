// Instagram crop geometry — pure, display-independent math for the composer's
// image cropper. The cropper lets the dealer frame a photo EXACTLY as Instagram
// will render it (square / portrait / landscape feed, or a 9:16 story/reel
// cover), so what they preview in the composer is what publishes — no surprise
// auto-crop on Meta's side. Framework-free + browser-free so the math is
// unit-tested across the Deno↔Vite wall; the canvas draw lives in the View
// (components/instagram/ImageCropper.jsx).

export type IgRatio = { id: string; label: string; aspect: number };

// IG's canonical export width — published images land at 1080px on the width.
// We never upscale past the source, so a small photo stays crisp instead of
// blowing up into a soft 1080.
export const OUTPUT_WIDTH = 1080;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

// aspect = width / height. The three ratios IG renders in feed + carousel, plus
// the single 9:16 frame for stories and reels.
export const RATIO_PORTRAIT: IgRatio = { id: 'portrait', label: 'Vertical · 4:5', aspect: 4 / 5 };
export const RATIO_SQUARE: IgRatio = { id: 'square', label: 'Cuadrado · 1:1', aspect: 1 };
export const RATIO_LANDSCAPE: IgRatio = { id: 'landscape', label: 'Horizontal · 1.91:1', aspect: 1.91 };
export const RATIO_STORY: IgRatio = { id: 'story', label: 'Historia · 9:16', aspect: 9 / 16 };

// Portrait first: it's IG's modern feed default and gives a photo the most of
// the screen. Square and landscape follow.
export const FEED_RATIOS: IgRatio[] = [RATIO_PORTRAIT, RATIO_SQUARE, RATIO_LANDSCAPE];
export const STORY_RATIOS: IgRatio[] = [RATIO_STORY];

const ALL_RATIOS: IgRatio[] = [RATIO_PORTRAIT, RATIO_SQUARE, RATIO_LANDSCAPE, RATIO_STORY];

/** Publish mode → the ratios the cropper offers (story/reel are 9:16-only). */
export function ratiosForMode(mode: string): IgRatio[] {
  return mode === 'story' || mode === 'reel' ? STORY_RATIOS : FEED_RATIOS;
}

/** The ratio a fresh crop opens on for a mode — portrait for feed/carousel
 *  (IG's own default), 9:16 for a story or reel cover. */
export function defaultRatio(mode: string): IgRatio {
  return mode === 'story' || mode === 'reel' ? RATIO_STORY : RATIO_PORTRAIT;
}

/** Look a ratio up by id (falls back to portrait). */
export function ratioById(id: string | null | undefined): IgRatio {
  return ALL_RATIOS.find((r) => r.id === id) || RATIO_PORTRAIT;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The largest crop window of `aspect` (= w/h) that fits inside the image at
 * zoom 1 — i.e. the window that "covers" the IG frame with no empty gutter. A
 * wider-than-target image keeps full height and trims the sides; a taller (or
 * narrower) one keeps full width and trims top/bottom.
 */
export function baseCropSize(imgW: number, imgH: number, aspect: number): { w: number; h: number } {
  if (imgW <= 0 || imgH <= 0 || aspect <= 0) return { w: 0, h: 0 };
  if (imgW / imgH > aspect) {
    const h = imgH;
    return { w: h * aspect, h };
  }
  const w = imgW;
  return { w, h: w / aspect };
}

/**
 * Resolve a crop window in SOURCE-IMAGE pixels from the interactive state: the
 * target `aspect`, a `zoom` ≥ 1 that shrinks the base window (zoom in = tighter
 * crop), and a desired center (cx, cy) in image px. The center is clamped so the
 * window never leaves the image — IG never shows empty gutters. Returns the
 * source rect plus the clamped center, so the View can write the clamp straight
 * back into its drag state (no drift between live preview and final export).
 */
export function cropWindow(
  imgW: number,
  imgH: number,
  aspect: number,
  zoom: number,
  cx: number,
  cy: number,
): { sx: number; sy: number; sw: number; sh: number; cx: number; cy: number; zoom: number } {
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const base = baseCropSize(imgW, imgH, aspect);
  const sw = base.w / z;
  const sh = base.h / z;
  // With sw ≤ imgW and sh ≤ imgH the clamp range is always valid; guard the
  // degenerate empty-image case so the center stays finite.
  const ccx = sw >= imgW ? imgW / 2 : clamp(cx, sw / 2, imgW - sw / 2);
  const ccy = sh >= imgH ? imgH / 2 : clamp(cy, sh / 2, imgH - sh / 2);
  return { sx: ccx - sw / 2, sy: ccy - sh / 2, sw, sh, cx: ccx, cy: ccy, zoom: z };
}

/**
 * Output pixel size for a crop of `aspect` whose source window is `srcW` wide:
 * 1080px on the width, but never upscaled past the source (a 600px-wide crop
 * exports at 600, not a blurry 1080). Height follows the aspect exactly.
 */
export function outputSize(aspect: number, srcW: number): { w: number; h: number } {
  const w = Math.max(1, Math.round(Math.min(OUTPUT_WIDTH, srcW)));
  return { w, h: Math.max(1, Math.round(w / aspect)) };
}

// ── Carousel panorama ("sliding feed") ──────────────────────────────────────
// A wide landscape cut into equal vertical tiles, posted as a carousel: swiping
// pans across one continuous image. The trick that lets us reuse ALL of the
// cover/clamp/zoom math above: N tiles of aspect `a` laid side by side = ONE
// crop window of aspect N·a. So we frame the band with `cropWindow` (at the
// N·a aspect) and cut it into N equal strips — adjacent strips share an exact
// source edge at the same vertical crop, so the seams line up and the swipe
// reads as a single image. IG never re-crops it (each strip is exact IG spec).

// IG carousels hold 2–10 cards; a sliding panorama needs at least two strips.
export const MIN_SLICES = 2;
export const MAX_SLICES = 10;

// The per-tile ratios that read well as a sliding feed — tall portrait (most
// screen, IG's default) or square. A landscape per-tile ratio defeats the
// effect (the band would be near-flat), so the panorama tool offers only these.
export const TILE_RATIOS: IgRatio[] = [RATIO_PORTRAIT, RATIO_SQUARE];

/** Clamp a requested slice count into the IG carousel range, honoring an
 *  optional lower cap (e.g. the carousel's remaining room). */
export function clampSlices(n: number, cap: number = MAX_SLICES): number {
  const hi = clamp(Math.round(cap), MIN_SLICES, MAX_SLICES);
  return clamp(Math.round(n), MIN_SLICES, hi);
}

/** The crop-window aspect (w/h) for `slices` tiles of `tileAspect` side by side
 *  — i.e. the single window the framing math covers before we cut it. */
export function panoramaFrameAspect(slices: number, tileAspect: number): number {
  const n = Math.max(1, Math.round(slices));
  return n * tileAspect;
}

export type SliceRect = { sx: number; sy: number; sw: number; sh: number };

/**
 * Cut a resolved crop `win` into `slices` equal vertical strips, left→right (=
 * carousel swipe order). Every strip shares the band's top + height, and each
 * strip starts exactly where the previous one ended, so the tiles reassemble
 * into one seamless image. Each strip's aspect therefore equals the band aspect
 * ÷ slices = the per-tile ratio, by construction.
 */
export function sliceWindows(win: SliceRect, slices: number): SliceRect[] {
  const n = Math.max(1, Math.round(slices));
  const sw = win.sw / n;
  return Array.from({ length: n }, (_, i) => ({ sx: win.sx + i * sw, sy: win.sy, sw, sh: win.sh }));
}
