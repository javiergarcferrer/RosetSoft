-- Nómina (payroll) — employees + monthly payroll runs.
--
-- A run computes, per active employee, the gross, the TSS employee deductions
-- (SFS + AFP), ISR (DR monthly scale), and the net; plus the employer
-- contributions (SFS + AFP + INFOTEP). Posting it books one balanced asiento
-- (Debit sueldos + aportes patronales / Credit nóminas por pagar + TSS + INFOTEP
-- + IR-17). Items are kept as JSONB on the run for the payroll detail/volante.
--
-- Amounts are DOP. Single-tenant + team RLS.

create table if not exists public.employees (
  id             text primary key,
  profile_id     text not null default 'team' references public.profiles(id) on delete cascade,
  number         integer,
  name           text not null,
  cedula         text default '',
  position       text default '',
  monthly_salary numeric not null default 0,
  hire_at        timestamptz,
  active         boolean not null default true,
  notes          text default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists employees_profile_idx on public.employees(profile_id);
create unique index if not exists employees_number_uq on public.employees(profile_id, number) where number is not null;

alter table public.employees enable row level security;
do $$ begin
  create policy employees_team_rw on public.employees
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create table if not exists public.payroll_runs (
  id                text primary key,
  profile_id        text not null default 'team' references public.profiles(id) on delete cascade,
  number            integer,
  period_year       integer not null,
  period_month      integer not null check (period_month between 1 and 12),
  paid_at           timestamptz not null default now(),
  items             jsonb not null default '[]'::jsonb,
  gross             numeric not null default 0,
  tss_emp           numeric not null default 0,
  isr               numeric not null default 0,
  net               numeric not null default 0,
  employer_ss       numeric not null default 0,
  employer_infotep  numeric not null default 0,
  status            text not null default 'posted',
  journal_entry_id  text references public.journal_entries(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists payroll_runs_profile_idx on public.payroll_runs(profile_id);
create index if not exists payroll_runs_period_idx    on public.payroll_runs(profile_id, period_year, period_month);
create unique index if not exists payroll_runs_number_uq on public.payroll_runs(profile_id, number) where number is not null;

alter table public.payroll_runs enable row level security;
do $$ begin
  create policy payroll_runs_team_rw on public.payroll_runs
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
