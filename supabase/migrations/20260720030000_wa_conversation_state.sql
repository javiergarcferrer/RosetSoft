-- Per-conversation CRM state for the WhatsApp inbox: labels (tags), a private
-- internal note (never sent to the customer), and a snooze expiry. Keyed by the
-- conversation's phone_key (phoneKey(phone)) since threads are derived from
-- wa_messages, not a conversation entity. One row per (profile_id, phone_key).
-- Additive + idempotent; PK is an app-generated text id like every other table.
create table if not exists public.wa_conversation_state (
  id                text primary key,
  profile_id        text not null default 'team',
  phone_key         text not null,
  labels            jsonb not null default '[]'::jsonb,
  note              text,
  snooze_expires_at timestamptz,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create unique index if not exists wa_conversation_state_key
  on public.wa_conversation_state (profile_id, phone_key);

alter table public.wa_conversation_state enable row level security;
drop policy if exists "team can read wa_conversation_state" on public.wa_conversation_state;
create policy "team can read wa_conversation_state" on public.wa_conversation_state
  for select to authenticated using (true);
drop policy if exists "team can write wa_conversation_state" on public.wa_conversation_state;
create policy "team can write wa_conversation_state" on public.wa_conversation_state
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
