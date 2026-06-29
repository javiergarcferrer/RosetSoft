-- dev_todos — a tiny shared backlog the owner types from the phone (in the
-- admin bug console) and the developer (Claude) reads + checks off. Persisted to
-- the DB on purpose: localStorage would be invisible to the developer; this
-- table is the shared channel. Additive + idempotent, team-scoped like the rest.
create table if not exists dev_todos (
  id          text primary key,
  profile_id  text not null default 'team',
  text        text not null default '',
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists dev_todos_profile_idx on dev_todos (profile_id, done, created_at desc);

alter table dev_todos enable row level security;
drop policy if exists dev_todos_rw on dev_todos;
create policy dev_todos_rw on dev_todos for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
