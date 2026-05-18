-- profiles.password_set_at — closes the invite-flow gap where a
-- user clicked the magic-link in their invitation, landed signed
-- in, and could navigate the app… but had never set a password.
-- The moment that recovery session expired (or they signed out),
-- they were locked out forever with no way back in short of a
-- fresh invite.
--
-- The fix is to force every invitee onto a "create your password"
-- screen on first sign-in. password_set_at is the bit that drives
-- the gate: null = they haven't created a password yet, render
-- the setup screen; non-null = they have one, render the app.
--
-- Default null. The invite-user edge function leaves it null on
-- profile creation (the invitee genuinely doesn't have a password
-- yet — Supabase's inviteUserByEmail creates an auth.users row
-- with no password set). When the user submits the new-password
-- form, the SetPassword page calls supabase.auth.updateUser({
-- password }) and then stamps this column.
--
-- Backfill: every existing user got into the system under the
-- old self-signup flow, which required them to enter a password
-- at signup. So they all have a password by definition — backfill
-- password_set_at to created_at as a "they've definitely set a
-- password by now" proxy. The 'team' shared-settings row stays
-- null (it's not a real user with a real auth row).

alter table public.profiles
  add column if not exists password_set_at timestamptz;

update public.profiles
   set password_set_at = created_at
 where password_set_at is null
   and id <> 'team'
   and role in ('admin', 'employee');
