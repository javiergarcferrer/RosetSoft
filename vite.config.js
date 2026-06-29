import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

  // A unique id per build. On Vercel the git commit SHA is the natural
  // choice (stable per deploy); locally we fall back to a timestamp so
  // each `npm run build` differs. It's baked into the client (as
  // VITE_BUILD_ID) AND written to dist/version.json by the plugin below;
  // the running app polls version.json and reloads when the two diverge,
  // so an open tab picks up a new deploy without a manual refresh.
  const buildId =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    env.VITE_BUILD_ID ||
    String(Date.now());

  // Deploy telemetry for the JARVIS dashboard: the commit this deploy runs
  // plus a short git log ("cambios en vigor"). Vercel exposes the commit
  // metadata as env vars; the log comes from the build checkout (Vercel's
  // clone is shallow — whatever depth it has is plenty for a feed). Every
  // value is optional: a missing git binary or repo just leaves the panel
  // empty, never breaks the build.
  let gitLog = [];
  try {
    gitLog = execSync('git log -n 12 --pretty=format:%h%x09%ct%x09%s', { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ct, ...rest] = line.split('\t');
        return { sha, at: Number(ct) * 1000, msg: rest.join('\t') };
      });
  } catch { /* no git in the build environment */ }

  const buildMeta = {
    sha: process.env.VERCEL_GIT_COMMIT_SHA || gitLog[0]?.sha || '',
    ref: process.env.VERCEL_GIT_COMMIT_REF || '',
    msg: process.env.VERCEL_GIT_COMMIT_MESSAGE || gitLog[0]?.msg || '',
    builtAt: Date.now(),
    log: gitLog,
  };

  const emitVersion = {
    name: 'emit-version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ id: buildId }),
      });
    },
  };

  // Absolute origin for the link-preview (og:image) tags in index.html.
  // WhatsApp/Facebook reject a relative og:image, so we bake a full URL at
  // build time. On Vercel, VERCEL_PROJECT_PRODUCTION_URL is the stable
  // production host (no scheme); an explicit VITE_PUBLIC_ORIGIN overrides it,
  // and we fall back to the known production domain so a preview never points
  // at nothing. Plain string substitution into the %VITE_PUBLIC_ORIGIN%
  // placeholders — Vite doesn't expand arbitrary %TOKENS% on its own.
  const publicOrigin =
    env.VITE_PUBLIC_ORIGIN ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : '') ||
    'https://www.alcover.do';

  const injectOgOrigin = {
    name: 'inject-og-origin',
    // index.html goes through Vite's HTML pipeline...
    transformIndexHtml(html) {
      return html.split('%VITE_PUBLIC_ORIGIN%').join(publicOrigin);
    },
    // ...but the per-link preview launchers (public/p/*.html) are copied
    // verbatim from public/ and never see transformIndexHtml. Their og:image
    // MUST resolve to the SAME host that serves them (soft.alcover.do, not the
    // www marketing site, which 404s these assets and collapses the WhatsApp
    // card to text-only), so substitute the placeholder in the COPIED output
    // here. closeBundle runs after Vite has copied publicDir into dist.
    closeBundle() {
      const dir = join(process.cwd(), 'dist', 'p');
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.html')) continue;
        const p = join(dir, f);
        const src = readFileSync(p, 'utf8');
        if (!src.includes('%VITE_PUBLIC_ORIGIN%')) continue;
        writeFileSync(p, src.split('%VITE_PUBLIC_ORIGIN%').join(publicOrigin));
      }
    },
  };

  return {
    base,
    plugins: [react(), emitVersion, injectOgOrigin],
    resolve: {
      // The codebase imports with explicit `.js` / `.jsx` extensions
      // (`from '../lib/format.js'`) — an ESM-purist discipline that
      // predates the TypeScript migration. esbuild's dev pipeline
      // resolves those to `.ts`/`.tsx` transparently, but Rollup
      // (the production builder) does not. These aliases rewrite any
      // relative `*.js` / `*.jsx` import to its extension-less form
      // so Vite's own resolver can find either `.ts`, `.tsx`, or the
      // original `.js`/`.jsx`. Means we can flip a file from
      // `.js` → `.ts` (or `.jsx` → `.tsx`) without touching every
      // call site.
      alias: [
        { find: /^(\.{1,2}\/.*)\.jsx$/, replacement: '$1' },
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
      'import.meta.env.VITE_BUILD_ID':          JSON.stringify(buildId),
      'import.meta.env.VITE_BUILD_META':        JSON.stringify(JSON.stringify(buildMeta)),
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            // react-pdf is the quote PDF renderer; the quote-builder +
            // accounting workspace lazy-import it via dynamic import so the
            // initial bundle stays under 500 KB.
            reactpdf: ['@react-pdf/renderer'],
            // Leaflet is likewise dynamic-imported (only when a dealer opens
            // container tracking), so it gets its own on-demand chunk.
            leaflet: ['leaflet'],
            react: ['react', 'react-dom', 'react-router-dom'],
            // Stable vendor tiers split out of the app's `index` chunk: these
            // change far less often than our code (which rebuilds every
            // deploy), so giving them their own hashed files lets the browser
            // keep them cached across releases instead of re-downloading them
            // on every push.
            supabase: ['@supabase/supabase-js'],
            icons: ['lucide-react'],
          },
        },
      },
    },
    worker: { format: 'es' },
  };
});
