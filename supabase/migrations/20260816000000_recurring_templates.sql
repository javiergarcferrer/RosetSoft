-- Recurring transactions — memorized templates (v1: recurring expenses/bills)
-- the dealer generates with one click. Additive + idempotent.

create table if not exists recurring_templates (
  id           text primary key,
  profile_id   text not null default 'team',
  name         text not null default 'Recurrente',
  kind         text not null default 'expense',
  freq         text not null default 'monthly',
  interval     integer not null default 1,
  start_at     timestamptz not null default now(),
  next_run_at  timestamptz not null default now(),
  end_at       timestamptz,
  status       text not null default 'active',
  last_run_at  timestamptz,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table recurring_templates drop constraint if exists recurring_templates_freq_chk;
alter table recurring_templates add  constraint recurring_templates_freq_chk check (freq in ('weekly', 'monthly', 'yearly'));
alter table recurring_templates drop constraint if exists recurring_templates_status_chk;
alter table recurring_templates add  constraint recurring_templates_status_chk check (status in ('active', 'paused'));

create index if not exists recurring_templates_profile_idx on recurring_templates (profile_id);

alter table recurring_templates enable row level security;
drop policy if exists recurring_templates_rw on recurring_templates;
create policy recurring_templates_rw on recurring_templates for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
