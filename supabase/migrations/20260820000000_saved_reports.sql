-- Saved report views (memorized reports) — a named shortcut to a report at a
-- given path + query (filters/period encoded in the URL). Additive.

create table if not exists saved_reports (
  id          text primary key,
  profile_id  text not null default 'team',
  name        text not null,
  path        text not null,
  search      text default '',
  created_at  timestamptz not null default now()
);

create index if not exists saved_reports_profile_idx on saved_reports (profile_id);

alter table saved_reports enable row level security;
drop policy if exists saved_reports_rw on saved_reports;
create policy saved_reports_rw on saved_reports for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
