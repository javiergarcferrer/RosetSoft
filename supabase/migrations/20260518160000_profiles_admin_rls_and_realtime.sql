-- Tighten profile RLS to admin-only writes for non-self rows, and
-- turn on Supabase Realtime for `public.profiles` so admin sessions
-- see each other's edits live.
--
-- Background
-- ----------
-- Until now, profiles RLS was:
--   create policy "team can write" on public.profiles
--     for all to authenticated using (true) with check (true)
--
-- Every signed-in employee could INSERT / UPDATE / DELETE any row in
-- the table — the only thing stopping a determined ex-admin from
-- flipping their own role back to 'admin' from the JS console was
-- the UI's `isAdmin` check, which is not a security boundary. For a
-- 2-person trusted team this was fine, but if the dealership grows
-- it's a hole. We tighten now so the rule is enforced in Postgres
-- instead of in React.
--
-- The new model
-- -------------
--   SELECT  — any authenticated user (admin Users page needs the list,
--             ensureDefaultProfile needs to see its own row).
--   INSERT  — self OR admin. Lets ensureDefaultProfile bootstrap a
--             brand-new user's profile on first sign-in. invite-user
--             uses service-role which bypasses RLS, so this doesn't
--             affect the invite path.
--   UPDATE  — self OR admin. Lets SetPassword stamp `password_set_at`
--             and `last_sign_in_at` flow without admin privileges.
--             The privilege-escalation trigger below blocks non-admins
--             from changing their own role / active / commission_pct.
--   DELETE  — admin only. Plain employees can't remove themselves or
--             anyone else. The client-side mop-up in lib/invite.js
--             therefore requires the caller to be an admin, which
--             matches the UI gating.
--
-- Realtime
-- --------
-- The Supabase Realtime daemon watches the `supabase_realtime`
-- publication. Adding `public.profiles` to it makes every INSERT /
-- UPDATE / DELETE on the table emit a server-sent event to subscribed
-- channels — AppContext.jsx wires one up so an admin's deletion in
-- another tab updates this tab's user list without a refresh.

-- ---------------------------------------------------------------------------
-- 1. is_admin(uid) — read profile role without re-entering RLS
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the function runs with the owner's privileges
-- (bypassing the very policies we're about to define — without this,
-- a policy that calls is_admin() would recurse into another policy
-- evaluation on the same row and Postgres aborts with "infinite
-- recursion detected"). STABLE so Postgres can cache the result
-- within a single query plan. search_path pinned to defang the
-- standard SECURITY DEFINER footgun.
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.profiles
     where id = uid::text
       and role = 'admin'
       and active = true
  );
$$;

grant execute on function public.is_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Replace the all-permissive write policy with three granular ones
-- ---------------------------------------------------------------------------
-- The read policy ("team can read") stays untouched — every signed-in
-- user still sees the full profiles list, which is what the admin
-- Users page, commissions report, and quote-attribution badges need.
drop policy if exists "team can write" on public.profiles;

drop policy if exists "self or admin insert" on public.profiles;
create policy "self or admin insert" on public.profiles
  for insert to authenticated
  with check (id = auth.uid()::text or public.is_admin(auth.uid()));

drop policy if exists "self or admin update" on public.profiles;
create policy "self or admin update" on public.profiles
  for update to authenticated
  using      (id = auth.uid()::text or public.is_admin(auth.uid()))
  with check (id = auth.uid()::text or public.is_admin(auth.uid()));

drop policy if exists "admin delete" on public.profiles;
create policy "admin delete" on public.profiles
  for delete to authenticated
  using (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Block self-privilege escalation
-- ---------------------------------------------------------------------------
-- The UPDATE policy above lets a user write their own row (needed for
-- SetPassword + last_sign_in_at + their own name). But that row also
-- carries role / active / commission_pct — fields a non-admin must
-- not be able to mutate even on themselves, or "Empleado promotes
-- self to Admin" is one console command away. A BEFORE UPDATE trigger
-- enforces the invariant Postgres-side, so RLS stays simple and the
-- restriction can't be bypassed by combining policies cleverly.
create or replace function public.prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.id = auth.uid()::text and not public.is_admin(auth.uid()) then
    if new.role is distinct from old.role then
      raise exception 'No puedes cambiar tu propio rol.'
        using errcode = '42501';
    end if;
    if new.active is distinct from old.active then
      raise exception 'No puedes cambiar tu propio estado activo.'
        using errcode = '42501';
    end if;
    if new.commission_pct is distinct from old.commission_pct then
      raise exception 'No puedes cambiar tu propia comisión.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_self_privilege_escalation on public.profiles;
create trigger profiles_prevent_self_privilege_escalation
  before update on public.profiles
  for each row
  execute function public.prevent_self_privilege_escalation();

-- ---------------------------------------------------------------------------
-- 4. Add profiles to the supabase_realtime publication
-- ---------------------------------------------------------------------------
-- Wrapped in a DO block so re-running the migration on a project
-- where the table is already published is a no-op. Without this
-- guard, the second migration apply would fail with "relation
-- public.profiles is already member of publication".
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end$$;
