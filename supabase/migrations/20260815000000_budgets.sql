-- Presupuesto (budgets vs actuals) — one annual budget amount per chart account.
-- Additive + idempotent.

create table if not exists budgets (
  id           text primary key,
  profile_id   text not null default 'team',
  year         integer not null,
  account_code text not null,
  amount       numeric not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists budgets_key_uq     on budgets (profile_id, year, account_code);
create index        if not exists budgets_profile_idx on budgets (profile_id);

alter table budgets enable row level security;
drop policy if exists budgets_rw on budgets;
create policy budgets_rw on budgets for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
