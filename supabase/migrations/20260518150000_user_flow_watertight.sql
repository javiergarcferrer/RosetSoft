-- User flow watertighting. Closes four structural gaps the dealer
-- bumped into in one afternoon:
--
--   1. `profiles` had no `updated_at` column, but the delete-user
--      Edge Function and the admin Users page both wrote to it.
--      Result: "could not find the updated_at column of profiles in
--      the schema cache" on every Eliminar/Desactivar click. We add
--      the column + a trigger that bumps it on every UPDATE so the
--      client never has to stamp it by hand.
--
--   2. No UNIQUE constraint on `profiles.email`. Supabase Auth
--      enforces uniqueness on `auth.users.email`, but our profile
--      table didn't, so an admin could end up with two rows for the
--      same person (e.g. after a manual cleanup that left an orphan
--      profile behind, the next invite would create a second row).
--      We add a case-insensitive unique index, scoped to real users
--      (the shared 'team' row has no email and is excluded).
--
--   3. When an admin deleted a user directly from the Supabase
--      Dashboard (Auth → Users → … → Delete), the `auth.users` row
--      went away but the matching profile row stayed, becoming a
--      ghost that the admin Users page still rendered and that
--      blocked re-invitations under the same email. We install a
--      trigger on `auth.users` so the matching profile row is
--      hard-deleted automatically, no matter which path was used to
--      remove the auth row (Dashboard, Edge Function, or SQL).
--
--   4. Existing orphan profiles get cleaned up now so the admin
--      Users page reflects reality after this migration runs.
--
-- We also drop the previous "tombstone" model where a deactivated
-- user kept their profile row (active=false, last_sign_in_at set)
-- for historical commission attribution. The dealer's team is two
-- people; the trade-off of "kept profile rows clutter the UI" no
-- longer makes sense. From here on, deletion is symmetric: auth row
-- gone ↔ profile row gone. Quote attribution via
-- quotes.created_by_user_id falls back to NULL (the FK is already
-- `on delete set null`), so the rest of the system survives a delete
-- without errors — the commissions report just skips those quotes,
-- which is the right behavior when the dealer is no longer with
-- the team.

-- ---------------------------------------------------------------------------
-- 1. profiles.updated_at
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists updated_at timestamptz not null default now();

-- Backfill from the best-available signal we still have. Use the
-- most recent of last_sign_in_at / password_set_at / created_at so
-- rows ordered by updated_at give a sensible "most recently active"
-- ordering in the admin UI right away.
update public.profiles
   set updated_at = greatest(
     coalesce(last_sign_in_at, created_at),
     coalesce(password_set_at,  created_at),
     created_at
   )
 where updated_at <= created_at;

create or replace function public.profiles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.profiles_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Case-insensitive unique email
-- ---------------------------------------------------------------------------
-- Excludes the shared 'team' row (no email) and tolerates legacy
-- profile rows with NULL email. Two rows with NULL email are still
-- allowed; the constraint only kicks in on non-null emails.
drop index if exists profiles_email_unique_idx;
create unique index profiles_email_unique_idx
  on public.profiles (lower(email))
  where email is not null and id <> 'team';

-- ---------------------------------------------------------------------------
-- 3. auth.users delete → cascade to public.profiles
-- ---------------------------------------------------------------------------
-- security definer so the trigger can write into public.profiles
-- regardless of the deleter's role. Search path is pinned so a
-- shadowed `profiles` in another schema can't hijack the write.
create or replace function public.handle_auth_user_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.profiles where id = old.id::text;
  return old;
end;
$$;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row
  execute function public.handle_auth_user_deleted();

-- ---------------------------------------------------------------------------
-- 4. Clean up existing orphan profile rows
-- ---------------------------------------------------------------------------
-- A profile row is an orphan when it's a real user (role admin or
-- employee) but no auth.users row exists with the matching id. These
-- show up after a previous "delete user from the Dashboard" event
-- when the cascade trigger above didn't exist yet — the admin Users
-- page still listed them, and re-inviting under the same email
-- would have hit the new unique-email index and failed.
delete from public.profiles p
 where p.id <> 'team'
   and p.role in ('admin', 'employee')
   and not exists (
     select 1 from auth.users u where u.id::text = p.id
   );
