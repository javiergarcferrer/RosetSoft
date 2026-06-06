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
        ink: {
          50: '#f7f7f6',
          100: '#e8e7e3',
          200: '#cfccc4',
          300: '#aba79a',
          400: '#878374',
          500: '#6c6859',
          600: '#544f43',
          700: '#3b3830',
          800: '#26241f',
          900: '#171612',
        },
        // Alcover electric violet. Anchored on #3600ff at the 600 step (the
        // primary-action color); lighter tints toward 50, deeper shades toward
        // 900. Generated as a constant-hue (253°) ladder so every step reads as
        // the same color, just brighter/darker. This REPLACED the previous
        // terracotta scale under the same `brand` token name, so every existing
        // `brand-*` usage (buttons, badges, map markers, the ::selection wash,
        // chart accents) flipped to violet in one move.
        brand: {
          50:  '#f3f0ff',
          100: '#e7e0ff',
          200: '#ccbefe',
          300: '#a890fd',
          400: '#7752ff',
          500: '#5729ff',
          600: '#3600ff',
          700: '#3000db',
          800: '#2904af',
          900: '#20077e',
        },
      },
      backgroundImage: {
        // Primary-CTA gradient — a touch of motion in the violet so the main
        // action button reads as a lit surface, not a flat fill.
        'brand-grad': 'linear-gradient(135deg, #4a1cff 0%, #3600ff 52%, #2c00d6 100%)',
        // Card surface sheen — a barely-there top-to-bottom gradient that gives
        // every card a faint lit-from-above quality (Radix/Linear "surface"
        // tonal step) instead of reading as a dead white rectangle.
        'card-grad': 'linear-gradient(180deg, #ffffff 0%, #fcfbf9 100%)',
        // Whole-app backdrop wash — a faint violet bloom top-right + a warm
        // terracotta bloom top-left, so the warm-editorial canvas feels lit and
        // white cards lift off it. Paired with grain (in index.css) for texture.
        'app-wash': 'radial-gradient(900px 480px at 100% -6%, rgba(54,0,255,0.055), transparent 60%), radial-gradient(720px 440px at -8% 4%, rgba(201,106,42,0.05), transparent 56%)',
      },
      boxShadow: {
        // Warm-tinted elevation ladder (shadow color = ink-700 #3b3830, not
        // neutral black) so depth reads as warm editorial paper, not cold SaaS.
        // hairline → resting card → raised/hover → floating overlay, plus the
        // violet focus ring and violet button glow.
        xs:   '0 1px 2px rgba(59,56,48,0.05)',
        sm:   '0 1px 2px rgba(59,56,48,0.06), 0 1px 3px rgba(59,56,48,0.05)',
        soft: '0 1px 2px rgba(59,56,48,0.05), 0 3px 8px rgba(59,56,48,0.06), 0 14px 30px -10px rgba(59,56,48,0.12)',
        md:   '0 2px 4px rgba(59,56,48,0.06), 0 10px 24px -6px rgba(59,56,48,0.14)',
        pop:  '0 18px 50px -12px rgba(23,22,18,0.30), 0 6px 16px -6px rgba(23,22,18,0.16)',
        focus:'0 0 0 4px rgba(54,0,255,0.16)',
        glow: '0 1px 2px rgba(54,0,255,0.30), 0 10px 26px -6px rgba(54,0,255,0.45)',
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
