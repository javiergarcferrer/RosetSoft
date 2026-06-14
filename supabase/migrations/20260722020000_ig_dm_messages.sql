-- Instagram Direct + Facebook Messenger DM inbox — the per-thread messages.
-- One row per message inside a conversation (see ig_dm_conversations). Mirrors
-- what meta-social's readDmThread returns so the thread view can render offline
-- and a webhook can append. Additive + idempotent.

create table if not exists ig_dm_messages (
  id              text primary key,
  profile_id      text not null default 'team',
  conversation_id text,
  direction       text,
  author_id       text,
  author_name     text,
  text            text,
  media_url       text,
  media_type      text,
  created_at      timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists ig_dm_messages_thread_idx
  on ig_dm_messages (conversation_id, created_at);

alter table ig_dm_messages enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'ig_dm_messages' and policyname = 'team ig_dm_messages'
  ) then
    create policy "team ig_dm_messages" on ig_dm_messages
      for all to authenticated using (true) with check (true);
  end if;
end $$;

notify pgrst, 'reload schema';
