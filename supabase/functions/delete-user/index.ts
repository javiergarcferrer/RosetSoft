// delete-user — admin-only endpoint that hard-deletes a team member
// from both Supabase Auth (`auth.users`) AND the application's
// `public.profiles` table. After a successful call, no trace of the
// user remains on the dealer side: they're invisible in the admin
// Users page, can't sign in, and can't be re-invited as a duplicate
// because the unique-email index has nothing to collide with.
//
// Why an Edge Function (vs. a client-side delete)
// -----------------------------------------------
// The client can delete a profile row via RLS, but it cannot delete
// the matching `auth.users` row — that needs the service-role key,
// which never leaves the server. Without removing the auth row a
// fired employee could still hold a valid session (or recover their
// password) and walk back in.
//
// Architecture
// ------------
//   1. Bearer JWT in Authorization → identify caller.
//   2. Verify caller is an active admin via the *anon* client + that
//      bearer token (Supabase Auth resolves auth.uid() from the JWT).
//   3. Refuse self-deletion (would lock the admin out).
//   4. Service-role client calls `auth.admin.deleteUser(id)`. The
//      `on_auth_user_deleted` Postgres trigger we installed in
//      migration 20260518150000 cascades the deletion to the profile
//      row, so the system ends in a consistent state after step 4.
//   5. Belt-and-suspenders: we also DELETE the profile row directly
//      from the service-role client. If the trigger is somehow
//      missing (e.g. a Supabase project that hasn't applied the
//      latest migration), this still leaves the system clean. If
//      the trigger already deleted the row, this is a no-op — the
//      `.delete().eq('id', id)` simply matches zero rows.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const SUPABASE_URL              = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  // ---- 1. Authenticate the caller --------------------------------------
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Authorization header required' }, 401);
  }

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: getUserErr } = await callerClient.auth.getUser();
  if (getUserErr || !userData?.user) {
    return jsonResponse({ error: 'Invalid or expired session' }, 401);
  }
  const callerUser = userData.user;

  // ---- 2. Verify the caller is an active admin -------------------------
  const { data: callerProfile, error: callerProfileErr } = await callerClient
    .from('profiles')
    .select('role, active')
    .eq('id', callerUser.id)
    .maybeSingle();
  if (callerProfileErr) {
    return jsonResponse({ error: 'Could not load caller profile' }, 500);
  }
  if (!callerProfile || callerProfile.role !== 'admin' || !callerProfile.active) {
    return jsonResponse({ error: 'Solo administradores pueden eliminar usuarios.' }, 403);
  }

  // ---- 3. Parse + validate the request body ----------------------------
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const targetId = (body.id || '').trim();
  if (!targetId) {
    return jsonResponse({ error: 'Falta el id del usuario.' }, 400);
  }
  if (targetId === callerUser.id) {
    return jsonResponse({ error: 'No puedes eliminar tu propia cuenta.' }, 400);
  }
  if (targetId === 'team') {
    // 'team' is the shared settings holder, not a real user. There's
    // no auth.users row to delete; refusing here keeps an admin from
    // accidentally wiping the company-wide settings.
    return jsonResponse({ error: 'No es un usuario real.' }, 400);
  }

  // ---- 4. Service-role client for the privileged operations ------------
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Delete the auth.users row. Supabase returns a "User not found"
  // error if the row is already gone — treat that as success so the
  // function is idempotent (an admin retrying after a network blip,
  // or cleaning up an orphan profile whose auth row was already
  // removed via the Dashboard, shouldn't see an error).
  const { error: delErr } = await adminClient.auth.admin.deleteUser(targetId);
  if (delErr) {
    const msg = (delErr.message || '').toLowerCase();
    const alreadyGone = msg.includes('not found') || msg.includes('does not exist');
    if (!alreadyGone) {
      return jsonResponse({ error: `No se pudo eliminar la cuenta: ${delErr.message}` }, 400);
    }
  }

  // ---- 5. Hard-delete the profile row (cascade safety net) -------------
  // The `on_auth_user_deleted` trigger should have already removed
  // this row when step 4 deleted the auth row. We delete here too as
  // belt-and-suspenders: if a project hasn't applied migration
  // 20260518150000 yet, the trigger doesn't exist, and without this
  // explicit delete the profile row would stay as a ghost.
  //
  // The delete is unconditional — we're not flipping `active`, we're
  // removing the row outright. Quote attribution via
  // `quotes.created_by_user_id` falls back to NULL (FK is `on delete
  // set null`); the rest of the system survives without error.
  const { error: profileErr } = await adminClient
    .from('profiles')
    .delete()
    .eq('id', targetId);
  if (profileErr) {
    return jsonResponse({ error: `Cuenta eliminada pero falló al borrar el perfil: ${profileErr.message}` }, 500);
  }

  return jsonResponse({ ok: true });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
