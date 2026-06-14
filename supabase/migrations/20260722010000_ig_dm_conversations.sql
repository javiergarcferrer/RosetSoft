-- Instagram Direct + Facebook Messenger DM inbox — the conversation list.
-- One row per thread the dealer can read/answer from the Messaging surface.
-- The live source of truth is Meta's Graph API (read through meta-social's
-- readDms); this table is the local mirror the inbox renders from and where a
-- webhook can land updates. Additive + idempotent.

create table if not exists ig_dm_conversations (
  id                 text primary key,
  profile_id         text not null default 'team',
  platform           text,
  participant_id     text,
  participant_name   text,
  participant_avatar text,
  last_message_at    timestamptz,
  last_message_text  text,
  last_direction     text,
  unread_count       int not null default 0,
  is_archived        boolean not null default false,
  synced_at          timestamptz,
  updated_at         timestamptz not null default now()
);

create index if not exists ig_dm_conversations_recent_idx
  on ig_dm_conversations (profile_id, last_message_at desc);
create index if not exists ig_dm_conversations_platform_idx
  on ig_dm_conversations (profile_id, platform);

alter table ig_dm_conversations enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'ig_dm_conversations' and policyname = 'team ig_dm_conversations'
  ) then
    create policy "team ig_dm_conversations" on ig_dm_conversations
      for all to authenticated using (true) with check (true);
  end if;
end $$;

notify pgrst, 'reload schema';
