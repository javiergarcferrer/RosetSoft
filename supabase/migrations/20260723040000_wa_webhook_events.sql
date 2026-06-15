-- wa-webhook reliability — a durable, replayable log of every VERIFIED inbound
-- webhook delivery from Meta. The webhook writes the raw payload here BEFORE
-- processing, so a delivered message can't be lost to a transient store error:
-- on a store failure the webhook answers 5xx (Meta redelivers) AND the row stays
-- here flagged unprocessed, powering the in-app "reception health" alarm + a
-- later replay. Deduped by id = 'wae-' + sha256(body), so Meta retries of the
-- same delivery collapse onto ONE row.
create table if not exists wa_webhook_events (
  id            text primary key,
  profile_id    text not null default 'team',
  received_at   timestamptz not null default now(),
  message_count int not null default 0,
  processed     boolean not null default false,
  process_error text,
  raw           jsonb not null default '{}'::jsonb
);

-- The reception-health panel queries unprocessed rows, newest first.
create index if not exists wa_webhook_events_unprocessed_idx
  on wa_webhook_events (processed, received_at desc);

alter table wa_webhook_events enable row level security;
-- Single-tenant: the team READS (the in-app reception alarm). Writes belong to
-- the webhook alone, via the service role (which bypasses RLS) — the app never
-- mutates the forensic log.
drop policy if exists wa_webhook_events_read on wa_webhook_events;
create policy wa_webhook_events_read on wa_webhook_events
  for select to authenticated using (true);

notify pgrst, 'reload schema';
