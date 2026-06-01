-- Fiscal periods (cierre contable) — lock a month so nothing can post into it.
--
-- A month with no row is OPEN. Closing inserts a row with status='closed'; a
-- BEFORE INSERT trigger on journal_entries then rejects any asiento whose
-- posted_at falls in that month — so the close is enforced at the DATABASE,
-- across every posting path (sales, expenses, purchases, imports, payments,
-- manual, reversals), not just the UI. Reopening flips the row back to 'open'.
--
-- Single-tenant + team RLS.

create table if not exists public.fiscal_periods (
  id         text primary key,
  profile_id text not null default 'team' references public.profiles(id) on delete cascade,
  year       integer not null,
  month      integer not null check (month between 1 and 12),
  status     text not null default 'closed' check (status in ('open','closed')),
  closed_at  timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists fiscal_periods_ym_uq on public.fiscal_periods(profile_id, year, month);

alter table public.fiscal_periods enable row level security;
do $$ begin
  create policy fiscal_periods_team_rw on public.fiscal_periods
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Reject postings into a closed month (evaluated in AST, no DST).
create or replace function public.enforce_open_period() returns trigger as $$
declare
  y integer;
  m integer;
  st text;
begin
  y := extract(year from (new.posted_at at time zone 'America/Santo_Domingo'))::int;
  m := extract(month from (new.posted_at at time zone 'America/Santo_Domingo'))::int;
  select status into st from public.fiscal_periods
    where profile_id = new.profile_id and year = y and month = m;
  if st = 'closed' then
    raise exception 'El período contable %/% está cerrado.', m, y using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists journal_entries_period_guard on public.journal_entries;
create trigger journal_entries_period_guard
  before insert on public.journal_entries
  for each row execute function public.enforce_open_period();

notify pgrst, 'reload schema';
