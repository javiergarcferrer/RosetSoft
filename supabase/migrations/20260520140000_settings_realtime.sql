-- Live-sync the team settings row across sessions.
--
-- The exchange rate lives in public.settings (settings.bsc). When the
-- daily auto-pull or the "Actualizar ahora" button updates it, only the
-- session that triggered the change saw it — every other open session
-- (and the quote panes inside it) kept a stale cached copy until reload,
-- because settings, unlike profiles, was never added to the realtime
-- publication. Adding it makes any settings change emit a server event;
-- AppContext subscribes and re-reads, so the rate updates everywhere at
-- once. Single source of truth, propagated live.
--
-- Default replica identity (primary key) is enough: we only need to know
-- the row changed and re-read it, not diff old vs new values.
--
-- Guarded so re-running the migration on a project where settings is
-- already published is a no-op.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'settings'
  ) then
    alter publication supabase_realtime add table public.settings;
  end if;
end$$;
