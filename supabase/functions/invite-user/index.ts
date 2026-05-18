// invite-user — admin-only endpoint that invites a new team member by
// email and pre-creates their profile row with the role and commission
// percentage the admin assigned. Replaces the previous client-side
// self-signup flow ("Registrarme"): the app is now invite-only, and the
// only way to create a new account is for an existing admin to call
// this function from /admin/users.
//
// Architecture
// ------------
//
//   1. Caller's JWT travels in the Authorization header.
//
//   2. We verify the caller via the *anon* client + that bearer token —
//      this hits Supabase Auth as the caller, so we see the caller's
//      real auth.uid(). Then we check their `profiles.role` row to
//      confirm they're an active admin. A regular employee posting to
//      this endpoint gets a 403; an anonymous request gets a 401.
//
//   3. We use the *service-role* client to call
//      `auth.admin.inviteUserByEmail()` — that's the only API path
//      Supabase exposes for sending the canonical "you've been invited"
//      email (renders the Invite User template configured in Auth →
//      Templates). The service-role key never leaves this function;
//      it's a function secret set via `supabase secrets set
//      SUPABASE_SERVICE_ROLE_KEY=…`.
//
//   4. With the new auth.users row in hand we upsert the matching
//      `profiles` row carrying the assigned role + commission +
//      active=true + invited_by. This means the invitee lands
//      ready-to-go after clicking the email link — they don't get
//      stuck on the "pending approval" Gate the way self-signups did.
//
// Bootstrap-admin caveat
// ----------------------
// The very first admin (javier@alcover.do) can't invite themselves —
// nobody else exists to call this function on their behalf. They sign
// up once via the Supabase Dashboard (Authentication → Users → "Add
// user" with their email), then sign in via /login. On that first
// sign-in, ensureDefaultProfile() on the client side promotes them to
// role='admin' because their email is in settings.admin_emails. After
// that, every subsequent user comes through this function.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// CORS — the function is called from the browser, so preflight has to
// pass. We accept any origin because Supabase Functions don't currently
// expose a way to read the configured site-URL list at runtime; if a
// stricter policy is wanted later, hard-code the allowed origins here.
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
    // Misconfiguration — fail loudly. The error message intentionally
    // omits which key is missing so we don't accidentally print
    // anything secret-adjacent into logs.
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  // ---- 1. Authenticate the caller --------------------------------------
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Authorization header required' }, 401);
  }

  // Anon client that forwards the caller's bearer token — Supabase
  // resolves auth.uid() from the JWT for us.
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
    return jsonResponse({ error: 'Solo administradores pueden invitar usuarios.' }, 403);
  }

  // ---- 3. Parse + validate the invitation body -------------------------
  let body: {
    email?: string;
    name?: string;
    role?: string;
    commissionPct?: number | string;
    redirectTo?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  const name  = (body.name || '').trim();
  const role  = (body.role || 'employee').trim();
  const pct   = clampCommissionPct(body.commissionPct);
  // The client passes its own origin (window.location.origin) as the
  // redirect target. We use it for the invite email's magic-link
  // landing page — without this, Supabase falls back to the
  // dashboard-configured Site URL, which defaults to
  // http://localhost:3000 on a fresh project and produces a broken
  // invite link for the recipient. Validate it's an http(s) URL and
  // drop it otherwise so we don't pass garbage through to Supabase.
  const redirectTo = typeof body.redirectTo === 'string'
    && /^https?:\/\//i.test(body.redirectTo)
    ? body.redirectTo
    : undefined;

  if (!email || !email.includes('@')) {
    return jsonResponse({ error: 'Correo electrónico inválido.' }, 400);
  }
  if (!name) {
    return jsonResponse({ error: 'Nombre requerido.' }, 400);
  }
  if (role !== 'admin' && role !== 'employee') {
    return jsonResponse({ error: "Rol debe ser 'admin' o 'employee'." }, 400);
  }

  // ---- 4. Service-role client for the privileged operations ------------
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Try sending the invite. Supabase returns a clean error when the
  // email already has an auth.users row — surface that to the caller
  // so the UI can show "ya existe una cuenta con ese correo" without
  // a 500. Pass `redirectTo` through when the caller supplied it so
  // the magic-link email lands the invitee at the dealer's actual
  // domain — not Supabase's default Site URL, which is
  // http://localhost:3000 on a fresh project and broke invitations
  // when the dealer first tried them in production.
  const { data: inviteData, error: inviteErr } =
    await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { name },
      ...(redirectTo ? { redirectTo } : {}),
    });
  if (inviteErr) {
    const msg = (inviteErr.message || '').toLowerCase();
    const alreadyExists = msg.includes('already') || msg.includes('exists') || msg.includes('registered');
    return jsonResponse(
      { error: alreadyExists
          ? 'Ya existe una cuenta con ese correo.'
          : `No se pudo enviar la invitación: ${inviteErr.message}` },
      alreadyExists ? 409 : 400,
    );
  }
  const invitedUser = inviteData?.user;
  if (!invitedUser?.id) {
    return jsonResponse({ error: 'Invitación enviada pero sin auth.users row' }, 500);
  }

  // ---- 5. Pre-create the profile row -----------------------------------
  // `active = false` + `last_sign_in_at = null` is the canonical
  // "invitation sent, awaiting acceptance" state. The admin Users page
  // surfaces these rows in a dedicated "Invitaciones sin aceptar"
  // section so they don't get confused with employees who actually
  // work in the system. When the invitee clicks the magic link and
  // signs in for the first time, ensureDefaultProfile() flips active
  // to true and stamps last_sign_in_at — the row promotes from
  // "invited" to "activo" at that moment, and only at that moment.
  //
  // Why this beats "active=true on invite": before this change, an
  // invitee who never clicked the link would still appear in the
  // active-employees count and show up in commission reports as a
  // legitimate teammate. Now they don't count until they actually
  // accept the invitation.
  const { error: profileErr } = await adminClient.from('profiles').upsert({
    id:              invitedUser.id,
    email,
    name,
    role,
    commission_pct:  pct,
    active:          false,
    last_sign_in_at: null,
    invited_by:      callerUser.id,
  });
  if (profileErr) {
    // The auth row exists but we couldn't make the profile. Surface
    // it cleanly — the admin can retry; an idempotent upsert won't
    // double-invite.
    return jsonResponse({ error: `Invitación enviada pero falló el perfil: ${profileErr.message}` }, 500);
  }

  return jsonResponse({
    ok: true,
    user: { id: invitedUser.id, email, name, role, commissionPct: pct },
  });
});

// ---- helpers -----------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function clampCommissionPct(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 50) return 50;
  return n;
}
