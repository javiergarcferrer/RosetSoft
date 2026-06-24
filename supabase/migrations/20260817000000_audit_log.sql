-- Audit log — an append-only trail of every change to the financial tables, for
-- DGII inalterability. A SECURITY DEFINER trigger writes it; clients can only
-- read (no client insert/update/delete policy). Additive + idempotent.

create table if not exists audit_log (
  id          text primary key,
  profile_id  text not null default 'team',
  logged_at   timestamptz not null default now(),
  user_id     text,
  action      text not null,
  table_name  text not null,
  row_id      text,
  before      jsonb,
  after       jsonb
);

create index if not exists audit_log_logged_idx on audit_log (logged_at desc);
create index if not exists audit_log_table_idx  on audit_log (table_name, row_id);

alter table audit_log enable row level security;
-- read-only for the team; the trigger (SECURITY DEFINER) is the only writer.
drop policy if exists audit_log_read on audit_log;
create policy audit_log_read on audit_log for select to authenticated using (true);

create or replace function log_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  uid text;
begin
  begin uid := auth.uid()::text; exception when others then uid := null; end;
  insert into audit_log (id, profile_id, logged_at, user_id, action, table_name, row_id, before, after)
  values (
    gen_random_uuid()::text,
    coalesce((case when tg_op = 'DELETE' then old.profile_id else new.profile_id end), 'team'),
    now(), uid, lower(tg_op), tg_table_name,
    (case when tg_op = 'DELETE' then old.id else new.id end)::text,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return null;
end; $$;

-- Attach to the financial tables. Correction stays by reversal (never edit a
-- posted asiento), and now every change is recorded immutably.
do $$
declare t text;
begin
  foreach t in array array['journal_entries','journal_lines','sales_postings','expenses','purchases','payments']
  loop
    execute format('drop trigger if exists audit_%1$s on %1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s for each row execute function log_audit()', t);
  end loop;
end $$;

notify pgrst, 'reload schema';
