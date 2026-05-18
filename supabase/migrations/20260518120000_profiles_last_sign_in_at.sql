-- profiles.last_sign_in_at — distinguishes "invitation accepted" from
-- "invitation still sitting in the user's inbox".
--
-- Until now, the admin Users page split rows by `active`: pending
-- vs activated. That worked when self-signup was the path because
-- new signups were active=false until an admin approved them, and
-- the act of being approved meant they could now sign in. With the
-- invite-flow change (commit 35dbcc7), the edge function pre-creates
-- profiles as active=true so the invitee lands ready to go after
-- clicking the magic link — but that also means *invited-but-not-yet-
-- clicked* users show up in the "Activos" list alongside real
-- employees, and the admin can't tell whether someone has actually
-- accepted their invitation.
--
-- We add a `last_sign_in_at` timestamp. ensureDefaultProfile() in
-- src/db/database.js stamps it on every sign-in so it's always
-- current. A row with `last_sign_in_at IS NULL AND active = true`
-- is precisely "invitation sent, link not yet clicked".
--
-- Backfill: any existing active profile gets `last_sign_in_at` set
-- to `updated_at` as a best-available proxy. The original signin
-- time isn't recorded anywhere we can recover, but updated_at is at
-- least guaranteed to be in the past — which is what the Users
-- page's "ever signed in" / "never signed in" split actually needs.
-- The 'team' settings row gets a fixed timestamp far in the past
-- so it never shows up as "pending acceptance".

alter table public.profiles
  add column if not exists last_sign_in_at timestamptz;

-- profiles only carries `created_at`, not `updated_at` — see
-- 20260514120000_init_schema.sql. The backfill uses created_at as a
-- floor; it's at least guaranteed to be in the past for any existing
-- row, which is what the Users page split needs.
update public.profiles
   set last_sign_in_at = created_at
 where active = true
   and last_sign_in_at is null
   and id <> 'team';

update public.profiles
   set last_sign_in_at = '1970-01-01T00:00:00Z'
 where id = 'team'
   and last_sign_in_at is null;

create index if not exists profiles_last_sign_in_idx
  on public.profiles(last_sign_in_at);
