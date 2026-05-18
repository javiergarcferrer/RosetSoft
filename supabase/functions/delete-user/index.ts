// delete-user — admin-only endpoint that removes a team member from
// Supabase Auth. The matching profile row is kept (with active=false)
// so historical commission attribution on quotes.created_by_user_id
// stays resolvable and the admin Users page can still surface the
// row in its "Desactivados" bucket.
//
// Why an Edge Function (vs. a client-side flip)
// ---------------------------------------------
// The client can update `profiles.active = false` via RLS, but it
// cannot delete an `auth.users` row — that needs the service-role
// key, which never leaves the server. Before this function existed,
// "Deactivate" only flipped the profile flag: the deactivated
// employee still showed up in Supabase Auth → Users, and a
// determined ex-employee could still get a valid session via
// password reset (the auth row was alive). Removing the auth row
// closes that door.
//
// Architecture mirrors invite-user
// --------------------------------
//   1. Bearer JWT in Authorization → identify caller.
//   2. Verify caller is an active admin via the *anon* client +
//      that bearer token (Supabase Auth resolves auth.uid() from
//      the JWT).
//   3. Refuse self-deletion (would lock the admin out).
//   4. Service-role client calls `auth.admin.deleteUser(id)`.
//   5. Flip the profile row to active=false (the client-side flow
//      that opens this function does the same flip optimistically,
//      but we do it here too so the contract is "this function
//      leaves the system in a consistent state regardless of how
//      its caller behaved").

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
    return jsonResponse({ error: 'Solo administradores pueden desactivar usuarios.' }, 403);
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
    return jsonResponse({ error: 'No puedes desactivar tu propia cuenta.' }, 400);
  }
  if (targetId === 'team') {
    // 'team' is the shared settings holder, not a real user. There's
    // no auth.users row to delete; refusing here keeps an admin from
    // accidentally trying.
    return jsonResponse({ error: 'No es un usuario real.' }, 400);
  }

  // ---- 4. Service-role client for the privileged operations ------------
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Delete the auth.users row. Supabase returns a "User not found"
  // error if the row is already gone — treat that as success so the
  // function is idempotent (an admin retrying after a network blip
  // shouldn't see an error).
  const { error: delErr } = await adminClient.auth.admin.deleteUser(targetId);
  if (delErr) {
    const msg = (delErr.message || '').toLowerCase();
    const alreadyGone = msg.includes('not found') || msg.includes('does not exist');
    if (!alreadyGone) {
      return jsonResponse({ error: `No se pudo eliminar la cuenta: ${delErr.message}` }, 400);
    }
  }

  // ---- 5. Flip the profile row to inactive -----------------------------
  // The client-side caller does this optimistically too, but doing it
  // here as well keeps the function's contract self-contained: after
  // a successful call, the system is in the state "auth.users gone,
  // profile.active = false", no matter what the client did before or
  // after invoking us.
  const { error: profileErr } = await adminClient
    .from('profiles')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', targetId);
  if (profileErr) {
    return jsonResponse({ error: `Cuenta eliminada pero falló al actualizar perfil: ${profileErr.message}` }, 500);
  }

  return jsonResponse({ ok: true });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
