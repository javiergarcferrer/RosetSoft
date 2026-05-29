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
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
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
        brand: {
          50: '#fdf6f0',
          100: '#fae8d8',
          200: '#f2cba6',
          300: '#e8a76d',
          400: '#dd8542',
          500: '#c96a2a',
          600: '#a55322',
          700: '#7d3e1c',
          800: '#5a2c14',
          900: '#3a1d0d',
        },
      },
      boxShadow: {
        soft: '0 1px 2px rgba(23,22,18,0.04), 0 8px 24px rgba(23,22,18,0.06)',
        pop:  '0 8px 28px rgba(23,22,18,0.18), 0 2px 6px rgba(23,22,18,0.10)',
        focus:'0 0 0 4px rgba(23,22,18,0.10)',
      },
      // Square-corner design language, matching alcover.do: every radius in
      // the scale is flattened to 0 so the whole `rounded-*` utility family
      // (incl. `rounded-full` pills/avatars/badges and the per-corner
      // variants) renders with sharp edges. Overriding the scale here is the
      // single source of truth — no need to touch the ~200 class call sites.
      borderRadius: {
        none: '0px',
        sm: '0px',
        DEFAULT: '0px',
        md: '0px',
        lg: '0px',
        xl: '0px',
        '2xl': '0px',
        '3xl': '0px',
        full: '0px',
      },
    },
  },
  plugins: [
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
