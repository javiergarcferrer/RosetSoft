/// <reference types="vite/client" />

/**
 * Typed `import.meta.env` for the public-by-design Supabase config.
 * Anything injected via VITE_* into the client bundle goes here so
 * `import.meta.env.VITE_X` has compile-time autocomplete and so a
 * typo (`VITE_SUPABSE_URL`) becomes a build error.
 *
 * Service-role keys and JWT secrets DO NOT belong here — those never
 * touch the client bundle (see vite.config.js for the allowlist).
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
