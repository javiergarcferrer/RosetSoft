import { SUPABASE_URL } from '../db/supabaseClient.js';

/**
 * Call the `invite-user` Edge Function to send a team invitation.
 *
 * The function lives at `${SUPABASE_URL}/functions/v1/invite-user` —
 * Supabase routes functions under that path. We pass the caller's
 * Supabase access token as the Bearer auth so the function can verify
 * the caller is an active admin server-side before doing anything
 * privileged.
 *
 * Throws an Error with a Spanish, dealer-facing message if the
 * function rejects. The most common errors:
 *
 *   400  email or name missing / invalid
 *   401  no session or expired token
 *   403  caller is not an admin
 *   409  the email already has an auth.users row
 *   500  service misconfiguration (service_role secret missing on
 *        the function) or transient Supabase error
 *
 * The function does two things server-side, atomically from the
 * caller's perspective:
 *   1. supabase.auth.admin.inviteUserByEmail(email)  — sends the email
 *   2. upserts the profile row with role + commission + active=true +
 *      invited_by = caller's auth.uid()
 *
 * If step 2 fails, the auth row was still created — the admin can
 * re-invite via the same flow and the function will hit the 409 path.
 */
export async function inviteUser({ session, email, name, role, commissionPct }) {
  if (!session?.access_token) {
    throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
  }
  const url = `${SUPABASE_URL}/functions/v1/invite-user`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, name, role, commissionPct }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty / non-JSON body */ }
  if (!res.ok) {
    throw new Error(data?.error || `No se pudo enviar la invitación (HTTP ${res.status}).`);
  }
  return data;
}
