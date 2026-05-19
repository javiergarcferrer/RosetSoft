import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// For GitHub Pages: set base to '/<repo-name>/' or use '/' for user.github.io.
// You can override via VITE_BASE env var when deploying.
const base = process.env.VITE_BASE || './';

export default defineConfig(({ mode }) => {
  // Load env from every source (empty prefix = all vars, not just VITE_-prefixed).
  // The Vercel ↔ Supabase integration injects SUPABASE_URL and SUPABASE_ANON_KEY
  // automatically; we pick those up and forward them into the client bundle as
  // the VITE_-prefixed names the app code already reads. No manual mirroring
  // in Vercel project settings is required.
  const env = loadEnv(mode, process.cwd(), '');

  const supabaseUrl  = env.VITE_SUPABASE_URL      || env.SUPABASE_URL      || '';
  const supabaseAnon = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';

  return {
    base,
    plugins: [react()],
    resolve: {
      // The codebase imports with explicit `.js` extensions
      // (`from '../lib/format.js'`) — an ESM-purist discipline that
      // predates the TypeScript migration. esbuild's dev pipeline
      // resolves those to `.ts`/`.tsx` transparently, but Rollup
      // (the production builder) does not. This alias rewrites any
      // relative `*.js` import to its extension-less form so Vite's
      // own resolver can find either `.ts`, `.tsx`, or the original
      // `.js`. Means we can flip a file from `.js` → `.ts` without
      // touching every call site.
      alias: [
        { find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' },
      ],
      extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
    },
    // Inject ONLY the two public-by-design Supabase vars into the client
    // bundle. SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET / POSTGRES_*
    // are never referenced here and must never leak into the browser.
    define: {
      'import.meta.env.VITE_SUPABASE_URL':      JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnon),
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            // pdf-lib + fontkit ride together in their own chunk; the
            // quote-builder lazy-imports them via dynamic import so the
            // initial bundle stays under 500 KB.
            pdflib: ['pdf-lib'],
            react: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
    worker: { format: 'es' },
  };
});
