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
            pdflib: ['pdf-lib'],
            react: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
  };
});
