import { createClient } from '@supabase/supabase-js';

// `import.meta.env` is undefined outside Vite (e.g. when a node test imports
// this transitively); guard the lookup so the module can still load.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const url = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

// Loud at startup so a misconfigured deploy is obvious in the console.
// `import.meta.env.MODE` is 'production' on Vercel builds, 'development' on
// `vite dev`. We always log the URL — the anon key is public-by-design
// (it's enforced by RLS) so logging its prefix is fine.
if (typeof window !== 'undefined') {
  if (!url || !anonKey) {
    console.error(
      '[supabase] missing env vars at build time.\n' +
      '  VITE_SUPABASE_URL:      ' + (url || '(empty)') + '\n' +
      '  VITE_SUPABASE_ANON_KEY: ' + (anonKey ? '(set, ' + anonKey.length + ' chars)' : '(empty)') + '\n' +
      'On Vercel, the Supabase integration provides SUPABASE_URL and SUPABASE_ANON_KEY; vite.config.js forwards those into the VITE_ slots at build time. Make sure the project has been REDEPLOYED since the integration was installed.'
    );
  } else {
    console.info('[supabase] connected to', url);
  }
}

export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'anon', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export const supabaseConfigured = !!(url && anonKey);

export const IMAGES_BUCKET = 'images';
export const PRICELIST_BUCKET = 'pricelist';

export function publicImageUrl(path) {
  if (!path) return null;
  const { data } = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

export function publicPricelistUrl(path) {
  if (!path) return null;
  const { data } = supabase.storage.from(PRICELIST_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}
