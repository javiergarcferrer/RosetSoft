import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For GitHub Pages: set base to '/<repo-name>/' or use '/' for user.github.io.
// You can override via VITE_BASE env var when deploying.
const base = process.env.VITE_BASE || './';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
          pdflib: ['pdf-lib'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
});
