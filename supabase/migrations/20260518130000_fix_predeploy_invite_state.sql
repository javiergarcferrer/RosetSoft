-- Roll back false-positive "active" profiles created before commit
-- 2d228d7 — the migration before this one (20260518120000) added
-- last_sign_in_at and backfilled existing active rows from
-- created_at, on the assumption that any row already active had
-- legitimately signed in at some point. That's true for users who
-- self-signed-up under the old flow, but NOT for invitees the old
-- edge function created with active=true: those people might never
-- have clicked their magic link, and they got promoted to "Activos"
-- in the Users page when they really belong in "Invitaciones sin
-- aceptar".
--
-- We can't recover their real first-sign-in time from our table,
-- but Supabase Auth's `auth.users.last_sign_in_at` is the source of
-- truth — it's updated by the auth gateway on every sign-in, with no
-- client-side hand involved. A null value there is definitive: the
-- user has never signed in.
--
-- The fix: any profile row where (a) we marked them active, but (b)
-- auth.users says they've never signed in, gets rolled back to
-- active=false + last_sign_in_at=null. The Users page then surfaces
-- them in the "Invitaciones sin aceptar" section, which is what
-- they should have been all along. When they eventually click the
-- email link, ensureDefaultProfile() promotes them to active=true
-- normally.
--
-- Safe to re-run: the WHERE clause is self-correcting. Subsequent
-- migrations won't touch already-active users.

update public.profiles p
   set active = false,
       last_sign_in_at = null
  from auth.users u
 where u.id::text = p.id
   and u.last_sign_in_at is null
   and p.active = true
   and p.role in ('admin', 'employee');
