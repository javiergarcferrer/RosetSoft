-- Add 'accounting' to the set of allowed profile roles.
--
-- Background
-- ----------
-- Until now `profiles.role` was constrained to ('admin', 'employee',
-- 'team'). 'admin' is the privileged operator (manages users, sees the
-- commissions report, edits settings). 'employee' is the day-to-day
-- sales user — they create quotes, attribute revenue to themselves,
-- and earn the commission percentage on accepted quotes. 'team' is a
-- vestigial placeholder for the shared-settings row (id='team') that
-- holds company-wide configuration; it is not a real user account.
--
-- The dealership now needs a fourth role: 'accounting'. This role
-- represents the finance person who books invoices and pays out
-- commissions at month-end. They are read-only with respect to the
-- sales workflow:
--
--   • They do NOT create quotes and they do NOT sell — nothing on the
--     quote workspace, the product catalog, or the orders pipeline is
--     theirs to edit.
--
--   • They DO need visibility into accepted quotes (to download the
--     PDF for invoicing) and into the commissions report (to know who
--     gets paid how much this month). Both of those views already
--     exist for admins; the frontend gate just needs to recognize
--     'accounting' as another role that can read them.
--
-- Why no new tables, columns, or RLS policies?
-- -------------------------------------------
-- This codebase's RLS model is "every authenticated user can read
-- every row in every table". See the long header on migration
-- 20260518110000_user_roles_and_commissions.sql for the rationale —
-- the team is small and trusted, they share customers and cover for
-- each other, and tightening reads to per-role policies would break
-- the quote-attribution badges and the commissions rollups that the
-- admin page already relies on. Write-gating happens client-side via
-- the React UI (the same way 'admin' vs 'employee' gating works
-- today). The privilege-escalation trigger from migration
-- 20260518160000_profiles_admin_rls_and_realtime.sql still blocks a
-- non-admin from flipping their own role / active / commission_pct,
-- which is the only hard security boundary that matters here. So all
-- this migration does is widen the CHECK constraint so the new
-- enumerated value is accepted by Postgres — every other concern is
-- already handled.
--
-- Idempotent: re-running this migration drops the existing constraint
-- (if any) and re-adds it, so applying it twice is safe.

alter table public.profiles
  drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'employee', 'accounting', 'team'));
