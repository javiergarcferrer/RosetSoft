-- User differentiation, per-user commission, and quote attribution.
--
-- The previous schema was single-tenant team-shared: a literal row in
-- the `profiles` table with id='team' held the team's settings, and
-- every authenticated user could read and write everything. This
-- migration keeps the team-wide RLS model (the team wants to see each
-- other's work) but introduces three new concepts:
--
--   1. Each user-bound profile row (id = auth.uid()) gains a `role`
--      ('admin' | 'employee'), a `commission_pct` (the cut they earn
--      on quotes they personally create), and an `active` flag (admin-
--      gated: new signups start inactive and see a "pending approval"
--      screen until an admin flips this true).
--
--   2. Quotes gain `created_by_user_id` — the auth.uid() of the dealer
--      who materialized the quote. The monthly commissions report
--      groups deposited quotes by this column.
--
--   3. The seed admin email lives in settings.admin_emails (jsonb array
--      of lowercase email strings) so the bootstrap admin —
--      javier@alcover.do — auto-activates on first login. Adding more
--      admins later is a one-line update on the settings row.
--
-- Why not RLS-enforce role-based access yet?
-- ------------------------------------------
-- The team wants every member to see every quote (they share customers,
-- they cover for each other). The "admin-only" pages (Users management,
-- Commissions report) are gated client-side via profile.role === 'admin'.
-- That's not a hard security boundary — a bad actor with the JS console
-- could navigate to the URLs — but for a small trusted dealership it's
-- the right trade-off. Tightening to RLS-enforced policies later is a
-- follow-up migration that doesn't require code changes here.

-- ---------------------------------------------------------------------------
-- 1. profiles — role / commission_pct / active / invited_by
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists role          text    default 'employee',
  add column if not exists commission_pct numeric default 0,
  add column if not exists active        boolean default false,
  add column if not exists invited_by    text    references public.profiles(id) on delete set null;

-- Role is constrained to a known set; we keep 'team' as a third value
-- so the shared-settings row (id='team') doesn't fail the constraint.
-- That row isn't a real user — it's a vestigial holder of company-wide
-- config — but it'll get matched by the constraint anyway because the
-- migration runs across all existing rows.
alter table public.profiles
  drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'employee', 'team'));

-- Commission percentage is a quote-creator's cut. Sensible upper bound
-- is 50% — anything higher is almost certainly a typo. Lower is 0
-- (some employees may be salaried, no commission).
alter table public.profiles
  drop constraint if exists profiles_commission_pct_check;
alter table public.profiles
  add constraint profiles_commission_pct_check
  check (commission_pct >= 0 and commission_pct <= 50);

-- The shared 'team' profile is technically just a settings holder, not
-- a user. Mark its role accordingly so the Users management page can
-- filter it out cleanly. (Existing row from init_schema.sql has role
-- defaulted to 'employee' from the column default; we correct it here.)
update public.profiles
  set role = 'team', active = true
  where id = 'team';

-- ---------------------------------------------------------------------------
-- 2. quotes.created_by_user_id — attribution for commission rollups
-- ---------------------------------------------------------------------------
alter table public.quotes
  add column if not exists created_by_user_id text
    references public.profiles(id) on delete set null;

create index if not exists quotes_created_by_idx
  on public.quotes(created_by_user_id);

-- Existing quotes have no creator on record. We deliberately leave
-- created_by_user_id NULL for those — the commissions report skips
-- unattributed rows (better to under-report a legacy quote than to
-- credit it to the wrong dealer).

-- ---------------------------------------------------------------------------
-- 3. Bootstrap admin allowlist on the shared settings row
-- ---------------------------------------------------------------------------
-- New columns on settings carry config that affects auth:
--
--   admin_emails    jsonb array of lowercase email strings. Any user
--                   signing in with one of these emails is auto-promoted
--                   to role='admin' + active=true on their first session.
--
-- Stored on the shared settings row (profile_id='team') so it's
-- editable from the admin UI without a code redeploy. We don't pin
-- this to migration time — a dealer can add another admin email by
-- updating one row.
alter table public.settings
  add column if not exists admin_emails jsonb default '[]'::jsonb;

-- Seed the bootstrap admin: javier@alcover.do. Until this user signs
-- in, no admin exists and the Users management page is unreachable.
-- The first signin with this email auto-activates them.
update public.settings
   set admin_emails = '["javier@alcover.do"]'::jsonb
 where profile_id = 'team'
   and (admin_emails is null or admin_emails = '[]'::jsonb);
