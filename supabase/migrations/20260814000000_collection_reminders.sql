-- Collections / dunning — a log of reminders sent per invoice + step, so the
-- cadence never double-nudges, plus the dunning policy on settings.
-- Additive + idempotent.

create table if not exists collection_reminders (
  id           text primary key,
  profile_id   text not null default 'team',
  customer_id  text,
  doc_id       text not null,
  doc_type     text default 'sale',
  channel      text default 'whatsapp',
  step_offset  integer not null default 0,
  message      text,
  status       text not null default 'sent',
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists collection_reminders_profile_idx on collection_reminders (profile_id);
create index if not exists collection_reminders_doc_idx     on collection_reminders (doc_id);

alter table collection_reminders enable row level security;
drop policy if exists collection_reminders_rw on collection_reminders;
create policy collection_reminders_rw on collection_reminders for all to authenticated using (true) with check (true);

-- the dunning cadence/policy lives as JSON on the team settings row
alter table settings add column if not exists dunning_policy jsonb;

notify pgrst, 'reload schema';
