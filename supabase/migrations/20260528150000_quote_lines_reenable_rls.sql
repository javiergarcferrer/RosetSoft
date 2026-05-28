-- Re-enable Row Level Security on public.quote_lines.
--
-- RLS + the "team can read"/"team can write" policies were established in the
-- init schema, but RLS got toggled OFF on this table by hand while debugging the
-- material-options write failure — whose real cause was the jammed migration
-- chain (a column that never got created), not RLS. With a public anon key,
-- leaving RLS off exposes every quote line to anyone holding that key. This
-- restores the documented default in the repo so security no longer depends on a
-- manual dashboard toggle. Idempotent: enabling when already on is a no-op, and
-- the policies are dropped-then-recreated to match the init definitions.
alter table public.quote_lines enable row level security;

drop policy if exists "team can read" on public.quote_lines;
create policy "team can read" on public.quote_lines
  for select to authenticated using (true);

drop policy if exists "team can write" on public.quote_lines;
create policy "team can write" on public.quote_lines
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
