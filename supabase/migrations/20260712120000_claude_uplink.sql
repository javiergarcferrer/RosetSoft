-- Claude uplink — the JARVIS dashboard's bidirectional channel to the Claude
-- agent. The dashboard writes `role:'user'` directive rows (status: pending →
-- seen → done); the agent reads pending rows from its session (via the
-- Supabase MCP), acts, and answers with `role:'claude'` rows. `kind` separates
-- conversation ('directive' | 'reply') from telemetry ('activity' | 'deploy').

create table if not exists public.claude_messages (
  id          text primary key,
  profile_id  text not null default 'team' references public.profiles(id) on delete cascade,
  role        text not null default 'user',
  kind        text not null default 'directive',
  content     text not null default '',
  status      text not null default 'pending',
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists claude_messages_created_idx
  on public.claude_messages (created_at desc);
create index if not exists claude_messages_pending_idx
  on public.claude_messages (status) where status = 'pending';

alter table public.claude_messages enable row level security;

drop policy if exists "team can read claude_messages" on public.claude_messages;
create policy "team can read claude_messages" on public.claude_messages
  for select to authenticated using (true);

drop policy if exists "team can write claude_messages" on public.claude_messages;
create policy "team can write claude_messages" on public.claude_messages
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
