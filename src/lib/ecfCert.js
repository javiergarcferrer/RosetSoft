// e-CF certificate upload (client side). Writes the .p12 + password into the
// write-only `ecf_credentials` table (the browser can never read it back; the
// ecf-send Edge Function reads it via the service role), and stamps a
// non-sensitive status flag on `settings` for the UI.
import { supabase } from '../db/supabaseClient.js';
import { updateSettings, TEAM_PROFILE_ID } from '../db/database.js';

/** Encode a File/Blob's bytes as base64 (chunked, to avoid call-stack limits). */
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Save the signing certificate. `upsert` WITHOUT `.select()` ⇒ PostgREST
 * return=minimal ⇒ no SELECT needed (which the write-only RLS denies).
 */
export async function saveEcfCredentials({ profileId = TEAM_PROFILE_ID, file, password, environment = 'cert' }) {
  if (!file) throw new Error('Selecciona el archivo .p12.');
  if (!password) throw new Error('Ingresa la clave del certificado.');
  const p12Base64 = await fileToBase64(file);
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('ecf_credentials').upsert({
    profile_id: profileId,
    p12_base64: p12Base64,
    password,
    environment,
    uploaded_at: nowIso,
    updated_at: nowIso,
  }, { onConflict: 'profile_id' });
  if (error) throw new Error(error.message || 'No se pudo guardar el certificado.');
  // Non-sensitive status for the UI.
  await updateSettings(profileId, { ecfCertUploadedAt: Date.now(), ecfEnvironment: environment });
}
