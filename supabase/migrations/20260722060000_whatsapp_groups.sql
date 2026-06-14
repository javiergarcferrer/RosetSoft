-- WhatsApp group messaging support.
--
-- The Cloud API now (2026) lets an Official Business Account send to and
-- receive from GROUPS, identified by a Meta group id (not a phone). The CRM's
-- thread identity was phone-keyed (wa_messages.phone → phoneKey); groups need a
-- parallel identity, so:
--   • wa_groups            — the local mirror of each group the number is in
--                            (subject/description/invite link/status), the same
--                            way wa_messages mirrors the chat log.
--   • wa_group_participants — the membership roster, kept live from the
--                            group_participants_update webhook.
--   • wa_messages.group_id  — when set, the message belongs to a group thread;
--                            `phone` then carries the PARTICIPANT who sent it
--                            (inbound) and is blank for our outbound sends.
-- Additive + idempotent; PKs are app/Meta text ids like every other table.

-- ── The group the business number belongs to ────────────────────────────────
create table if not exists public.wa_groups (
  id                text primary key,            -- Meta's group id
  profile_id        text not null default 'team',
  subject           text,                        -- group name
  description       text,
  icon_path         text,                        -- images bucket path, optional
  invite_link       text,
  -- 'active' | 'archived'. Archiving is a LOCAL hide (mirrors the inbox snooze):
  -- it never leaves the group on Meta's side, just drops it from the active inbox.
  status            text not null default 'active',
  participant_count integer,
  -- whether OUR business number is an admin of the group (gates manage actions).
  is_admin          boolean,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists wa_groups_profile_status
  on public.wa_groups (profile_id, status);

alter table public.wa_groups enable row level security;
drop policy if exists "team can read wa_groups" on public.wa_groups;
create policy "team can read wa_groups" on public.wa_groups
  for select to authenticated using (true);
drop policy if exists "team can write wa_groups" on public.wa_groups;
create policy "team can write wa_groups" on public.wa_groups
  for all to authenticated using (true) with check (true);

-- ── The membership roster (live from group_participants_update) ─────────────
create table if not exists public.wa_group_participants (
  id          text primary key,                  -- `${group_id}:${phoneKey}`
  profile_id  text not null default 'team',
  group_id    text not null references public.wa_groups (id) on delete cascade,
  phone       text not null,
  name        text,
  -- 'admin' | 'member'.
  role        text not null default 'member',
  -- defaulted so a re-sync can omit it (onConflict update won't reset it).
  joined_at   timestamptz default now(),
  -- null ⇒ still a member; set ⇒ left/removed (kept for history, hidden from the
  -- active roster).
  left_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists wa_group_participants_group
  on public.wa_group_participants (profile_id, group_id);

alter table public.wa_group_participants enable row level security;
drop policy if exists "team can read wa_group_participants" on public.wa_group_participants;
create policy "team can read wa_group_participants" on public.wa_group_participants
  for select to authenticated using (true);
drop policy if exists "team can write wa_group_participants" on public.wa_group_participants;
create policy "team can write wa_group_participants" on public.wa_group_participants
  for all to authenticated using (true) with check (true);

-- ── The message log gains a group dimension ─────────────────────────────────
alter table public.wa_messages add column if not exists group_id text;
create index if not exists wa_messages_group
  on public.wa_messages (profile_id, group_id);

notify pgrst, 'reload schema';
