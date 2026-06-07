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
        // Alcover terracotta — a warm, grounded clay. Chosen for its
        // neuropsychology: warm earth tones read as comfort, craftsmanship and
        // approachability (the right register for high-end furniture), where the
        // old electric violet read as cold tech. Anchored on the SAME hexes the
        // PDF already used (theme.ts: 50 #fbf4ec · 300 #e8a76d · 500 #c76b29 ·
        // 700 #7d3e1c) so screen, public link and printed paper finally share
        // one brand color instead of drifting (violet on screen vs terracotta on
        // paper). Constant-hue (~25°) ladder: lighter tints → 50, deeper shades
        // → 900. Every `brand-*` usage (buttons, badges, map markers, the
        // ::selection wash, focus ring, chart accents) flips to clay in one move.
        brand: {
          50:  '#fbf4ec',
          100: '#f7e7d4',
          200: '#eecbab',
          300: '#e8a76d',
          400: '#d9883f',
          500: '#c76b29',
          600: '#a85620',
          700: '#7d3e1c',
          800: '#612f16',
          900: '#4d2713',
        },
      },
      backgroundImage: {
        // Primary-CTA gradient — a touch of motion in the clay so the main
        // action button reads as a lit terracotta surface, not a flat fill.
        'brand-grad': 'linear-gradient(135deg, #d2772f 0%, #c0641f 52%, #9c4f1d 100%)',
        // Card surface sheen — a barely-there top-to-bottom gradient that gives
        // every card a faint lit-from-above quality (Radix/Linear "surface"
        // tonal step) instead of reading as a dead white rectangle.
        'card-grad': 'linear-gradient(180deg, #ffffff 0%, #fcfbf9 100%)',
        // Whole-app backdrop wash — two warm clay blooms (a brighter terracotta
        // top-right, a deeper clay top-left) so the warm-editorial canvas feels
        // lit and white cards lift off it. Paired with grain (in index.css) for
        // texture. Both blooms now share the brand hue (no more cold violet).
        'app-wash': 'radial-gradient(900px 480px at 100% -6%, rgba(199,107,41,0.06), transparent 60%), radial-gradient(720px 440px at -8% 4%, rgba(168,86,32,0.05), transparent 56%)',
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
