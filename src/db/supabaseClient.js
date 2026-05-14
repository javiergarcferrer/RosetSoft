import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error(
    'Missing Supabase env vars. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local (see .env.example).',
  );
}

export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'anon', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export const IMAGES_BUCKET = 'images';

export function publicImageUrl(path) {
  if (!path) return null;
  const { data } = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}
