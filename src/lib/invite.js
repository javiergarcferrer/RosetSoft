import { SUPABASE_URL } from '../db/supabaseClient.js';
import { db } from '../db/database.js';

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
  // Tell the function where to send the invitee after they accept.
  // We use the admin's current origin — whatever URL they're operating
  // from is exactly where the invitee should land. Without this, the
  // invite link redirects to whatever Supabase has set as Site URL,
  // which defaults to http://localhost:3000 on a fresh project and
  // breaks invitations until the dealer fixes it in the dashboard.
  // Passing redirectTo explicitly per-call survives any future
  // dashboard misconfiguration. The URL still has to be on Supabase's
  // Redirect URLs allowlist (Auth → URL Configuration) to be honored.
  const redirectTo = typeof window !== 'undefined'
    ? window.location.origin + '/'
    : null;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, name, role, commissionPct, redirectTo }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty / non-JSON body */ }
  if (!res.ok) {
    throw new Error(data?.error || `No se pudo enviar la invitación (HTTP ${res.status}).`);
  }
  return data;
}

/**
 * Hard-delete a team member.
 *
 * Calls the `delete-user` Edge Function so the privileged
 * `auth.users` row goes away (only the server-side service-role key
 * can do that), then always mops up the `public.profiles` row from
 * the client too — `db.profiles.delete()` runs under RLS which the
 * "team can write" policy permits, and the row's FK targets are
 * `on delete set null` so quotes/customers survive.
 *
 * Why mop up from the client even when the edge function reports
 * success? Because we've been bitten twice by the function's
 * post-delete profile UPDATE failing in production (latest:
 * "Could not find the 'updated_at' column of 'profiles' in the
 * schema cache" — the migration that adds the column hasn't
 * propagated yet, but the function is already trying to write
 * there). When that happens the auth row IS gone, but the profile
 * lingers as a ghost row that the admin Users page still renders.
 * Doing the profile delete client-side, unconditionally, makes the
 * lifecycle watertight regardless of whether the migration has
 * landed or which version of the function is currently deployed.
 *
 *   400  caller tried to delete themselves or 'team' / missing id
 *   401  no session or expired token
 *   403  caller is not an admin
 *
 * Idempotent: re-running on a row whose auth/profile are already
 * gone resolves cleanly (the function treats "user not found" as
 * success, and the client-side profile delete is a no-op when the
 * row isn't there).
 */
export async function deleteUser({ session, id }) {
  if (!session?.access_token) {
    throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
  }
  const url = `${SUPABASE_URL}/functions/v1/delete-user`;
  // `authGone` tracks whether we believe the auth.users row was
  // successfully removed during this call. We default to true on a
  // 2xx and on the well-known "auth deleted but profile UPDATE
  // failed" message ("Cuenta eliminada pero …" / "updated_at"
  // schema cache), since in those cases the function's step 4
  // (auth.admin.deleteUser) ran successfully before it choked.
  let authGone = false;
  let hardError = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty / non-JSON body */ }
    if (res.ok) {
      authGone = true;
    } else {
      const msg = (data?.error || `HTTP ${res.status}`).toString();
      const authAlreadySucceeded =
        /cuenta eliminada/i.test(msg) ||
        /updated_at/i.test(msg) ||
        /schema cache/i.test(msg);
      if (authAlreadySucceeded) {
        authGone = true;
      } else {
        hardError = msg;
      }
    }
  } catch (netErr) {
    // Network blip / function offline. Profile mop-up still runs;
    // the warning is surfaced after.
    hardError = netErr?.message || String(netErr);
  }

  // Client-side mop-up. Runs whether the function succeeded, failed
  // softly, or didn't respond at all. RLS allows authenticated team
  // members to delete profile rows; FKs from quotes / invited_by are
  // `on delete set null` so we don't risk cascading data loss.
  try {
    await db.profiles.delete(id);
  } catch (profileErr) {
    throw new Error(
      hardError
        ? `No se pudo eliminar el usuario: ${hardError}`
        : (profileErr?.message || 'No se pudo eliminar el perfil.'),
    );
  }

  // Profile row is gone. If we also know the auth row is gone, this
  // was a clean delete — return success silently so the row just
  // disappears from the admin Users list. Otherwise surface a
  // warning so the admin knows to remove the auth row from the
  // Dashboard themselves.
  if (!authGone && hardError) {
    throw new Error(
      `Perfil eliminado, pero la cuenta de Supabase puede seguir activa: ${hardError}. ` +
      `Revisa Authentication → Users en el Dashboard.`,
    );
  }
  return { ok: true };
}
