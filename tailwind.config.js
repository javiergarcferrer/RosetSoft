import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  // .ts and .tsx land in the scan set so utility classes used by the
  // migrated TypeScript modules (Thumbnail, primitives, DebouncedInput,
  // ImageView, the lib/db/pdf modules' inline class strings) end up in
  // the production CSS. The previous `.{js,jsx}`-only glob silently
  // dropped any class that appeared exclusively inside a `.tsx` file —
  // the bigger-thumbnail visual fix was a recent victim of that.
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  // Class-based dark mode: the inline boot script in index.html stamps
  // `.dark` on <html> before first paint (no FOUC); lib/theme.js keeps it in
  // sync with the dealer's choice + the OS preference. Light mode is the
  // canonical design — every `--ink-*` / `--brand-*` light value below equals
  // the exact hex the app shipped before theming, so light mode is unchanged
  // to the pixel and dark mode is a pure variable swap (see src/index.css).
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Alcover brand type. Body/UI is Lausanne (the default `font-sans`);
        // headers use `font-display` (Söhne); the company wordmark uses
        // `font-wordmark` (Rauschen B). Faces are declared in src/index.css.
        sans: ['Lausanne', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Sohne', 'Lausanne', 'system-ui', 'sans-serif'],
        wordmark: ['"Rauschen B"', 'Sohne', 'Lausanne', 'serif'],
      },
      // Safe-area inset tokens, usable via Tailwind's spacing utilities:
      //   pt-safe-t, pb-safe-b, pl-safe-l, pr-safe-r, etc.
      // Combined with stock padding via arbitrary values where a minimum is
      // desired: pb-[max(0.75rem,env(safe-area-inset-bottom))].
      spacing: {
        'safe-t': 'env(safe-area-inset-top)',
        'safe-b': 'env(safe-area-inset-bottom)',
        'safe-l': 'env(safe-area-inset-left)',
        'safe-r': 'env(safe-area-inset-right)',
      },
      colors: {
        // Both ramps are CSS-variable-backed (channel triplets, so Tailwind's
        // `/<alpha-value>` opacity modifier keeps working). The light values
        // (src/index.css :root) are the EXACT hexes the app always used; the
        // dark values (.dark) invert lightness while holding the warm hue, so a
        // single `.dark` toggle re-skins the whole app. Surfaces that must stay
        // dark in both themes (the sidebar / mobile topbar) live inside
        // `.theme-chrome`, which locally re-pins these vars to the light ramp.
        ink: {
          50:  'rgb(var(--ink-50) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
        },
        // Alcover terracotta — a warm, grounded clay. Chosen for its
        // neuropsychology: warm earth tones read as comfort, craftsmanship and
        // approachability (the right register for high-end furniture), where the
        // old electric violet read as cold tech. Anchored on the SAME hexes the
        // PDF uses (theme.ts: 50 #fbf4ec · 300 #e8a76d · 500 #c76b29 · 700
        // #7d3e1c) so screen, public link and printed paper share one brand
        // color. In dark mode the ladder inverts lightness (deep clay tints at
        // the low end for fills, bright clay at the high end for text/accents)
        // so `text-brand-700` stays legible on a dark surface.
        brand: {
          50:  'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          300: 'rgb(var(--brand-300) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          800: 'rgb(var(--brand-800) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
        },
        // Semantic surface roles for literal panels (the `bg-white` /
        // page-canvas usages that the ink ramp can't express). `surface` = a
        // raised panel (cards, inputs, popovers), `surface-2` = a faint nested
        // fill, `canvas` = the page backdrop. Light values match today's
        // #ffffff / #f7f7f6 / #f3f1ed; dark values step lighter with elevation.
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          2: 'rgb(var(--surface-2) / <alpha-value>)',
        },
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
      },
      backgroundImage: {
        // Primary-CTA gradient — a touch of motion in the clay so the main
        // action button reads as a lit terracotta surface, not a flat fill.
        'brand-grad': 'linear-gradient(135deg, #d2772f 0%, #c0641f 52%, #9c4f1d 100%)',
        // Card surface sheen — a barely-there top-to-bottom gradient that gives
        // every card a faint lit-from-above quality (Radix/Linear "surface"
        // tonal step) instead of reading as a dead white rectangle.
        'card-grad': 'linear-gradient(180deg, #ffffff 0%, #fcfbf9 100%)',
      },
      boxShadow: {
        // Warm-tinted elevation ladder (shadow color = ink-700 #3b3830, not
        // neutral black) so depth reads as warm editorial paper, not cold SaaS.
        // hairline → resting card → raised/hover → floating overlay, plus the
        // terracotta focus ring and terracotta button glow.
        xs:   '0 1px 2px rgba(59,56,48,0.05)',
        sm:   '0 1px 2px rgba(59,56,48,0.06), 0 1px 3px rgba(59,56,48,0.05)',
        soft: '0 1px 2px rgba(59,56,48,0.05), 0 3px 8px rgba(59,56,48,0.06), 0 14px 30px -10px rgba(59,56,48,0.12)',
        md:   '0 2px 4px rgba(59,56,48,0.06), 0 10px 24px -6px rgba(59,56,48,0.14)',
        pop:  '0 18px 50px -12px rgba(23,22,18,0.30), 0 6px 16px -6px rgba(23,22,18,0.16)',
        focus:'0 0 0 4px rgba(199,107,41,0.18)',
        glow: '0 1px 2px rgba(168,86,32,0.30), 0 10px 26px -6px rgba(168,86,32,0.42)',
      },
    },
  },
  plugins: [
    // Enter/exit animation utilities (animate-in, fade-in, slide-in-from-*,
    // zoom-in-*) used by the elevated overlays (Modal, ProfileMenu, menus) so
    // they emerge with motion instead of popping. Standard Tailwind companion.
    tailwindcssAnimate,
    // Pointer-capability variants so we can size touch targets by the input
    // device, not by viewport width. iPads on Safari report pointer:coarse
    // even at >= sm widths, so a width-based breakpoint would under-size
    // them. Apple HIG / WCAG SC 2.5.5 want 44pt × 44pt minimum.
    function ({ addVariant }) {
      addVariant('coarse', '@media (pointer: coarse)');
      addVariant('fine', '@media (pointer: fine)');
    },
  ],
};
