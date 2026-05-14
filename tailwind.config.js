/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
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
      },
    },
  },
  plugins: [],
};
