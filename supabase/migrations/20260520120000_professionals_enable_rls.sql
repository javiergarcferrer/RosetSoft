-- Enable Row Level Security on public.professionals.
--
-- The table was created in 20260517140000 without RLS. Because it's still
-- reachable through the API (PostgREST), every row was readable/writable
-- by anyone holding the public anon key — which is exactly what Supabase's
-- Security Advisor flags as the critical "RLS Disabled in Public" finding.
--
-- Every other domain table (profiles, customers, quotes, orders,
-- materials, containers, …) already runs the single-tenant "team" policy
-- pair: any authenticated teammate has full access, the anon role has
-- none. We bring professionals in line with that same pattern — this is
-- the one table that slipped through when it was added.
--
-- Idempotent: enabling RLS is a no-op once on, and the policies are
-- dropped before being recreated, so the migration is safe to re-run.

alter table public.professionals enable row level security;

drop policy if exists "team can read"  on public.professionals;
drop policy if exists "team can write" on public.professionals;

create policy "team can read"  on public.professionals
  for select to authenticated using (true);
create policy "team can write" on public.professionals
  for all    to authenticated using (true) with check (true);
