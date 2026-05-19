import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// `import.meta.env` is undefined outside Vite (e.g. when a node test imports
// this transitively); guard the lookup so the module can still load.
const env: Partial<ImportMetaEnv> =
  (typeof import.meta !== 'undefined' && import.meta.env) || {};
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

// Exported so other modules (e.g. lib/invite.js) can build URLs to
// Supabase-hosted resources outside the JS SDK — notably the Edge
// Functions route at `${SUPABASE_URL}/functions/v1/<name>`.
export const SUPABASE_URL: string = url || 'http://localhost:54321';

export const supabase: SupabaseClient = createClient(SUPABASE_URL, anonKey || 'anon', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // True so invitees who click the magic link in their email land
    // with a real session — Supabase parses the recovery / invite
    // token out of the URL fragment on first page load. Without this,
    // the link works in Supabase's hosted account-creation flow but
    // not in the SPA after redirect.
    detectSessionInUrl: true,
  },
});

export const supabaseConfigured: boolean = !!(url && anonKey);

export const IMAGES_BUCKET = 'images';

export function publicImageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const { data } = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}
