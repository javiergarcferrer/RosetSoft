-- Instagram Direct (DM) inbox — the IG twin of wa_messages.
--
-- The CRM inbox's second channel. Inbound DMs land from the meta-webhook
-- (object=instagram, messaging[]); outbound from meta-social's igSendDm.
-- Threads group by `thread_key` (the counterpart's IG-scoped id / IGSID).
-- (The IG token columns on meta_social_config were added by the Instagram-Login
-- migration; this one only adds the message log.)

create table if not exists public.ig_messages (
  id            text primary key,
  profile_id    text not null default 'team' references public.profiles(id) on delete cascade,
  direction     text not null,                 -- 'in' | 'out'
  ig_message_id text,                           -- Meta's message id (mid.…) — dedupe key
  thread_key    text not null default '',       -- the counterpart's IGSID (thread identity)
  sender_id     text,
  recipient_id  text,
  username      text,
  name          text,
  kind          text not null default 'text',  -- text | image | video | audio | share | story_mention | …
  body          text,
  status        text not null default 'received',
  error         text,
  payload       jsonb,
  media_path    text,
  media_mime    text,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
alter table public.ig_messages enable row level security;

-- Single-tenant "team can write" (same shape as wa_messages and the rest).
drop policy if exists ig_messages_rw on public.ig_messages;
create policy ig_messages_rw on public.ig_messages
  for all to authenticated using (true) with check (true);

-- Dedupe inbound on Meta's message id (a retry must not double-log); partial so
-- many outbound rows with a null id before the API answers don't collide.
create unique index if not exists ig_messages_ig_message_id_key
  on public.ig_messages (ig_message_id) where ig_message_id is not null;
create index if not exists ig_messages_thread_idx
  on public.ig_messages (profile_id, thread_key, created_at);

notify pgrst, 'reload schema';
