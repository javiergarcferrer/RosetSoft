-- Claude chat — the JARVIS uplink goes live: a claude-chat Edge Function calls
-- the Claude API (Anthropic) so the dashboard console answers in real time.
-- The API key is a secret: WRITE-ONLY table (no client SELECT), written via a
-- SECURITY DEFINER RPC, read only by the claude-chat function with the service
-- role. Mirrors the shopify_config / ecf_credentials pattern — no dashboard
-- secret, no manual step. Non-sensitive status mirrors onto settings.

create table if not exists public.claude_config (
  profile_id  text primary key default 'team' references public.profiles(id) on delete cascade,
  api_key     text not null,
  model       text not null default 'claude-opus-4-8',
  updated_at  timestamptz not null default now()
);
alter table public.claude_config enable row level security;
-- Intentionally NO client policies: only the SECURITY DEFINER writer below and
-- the service-role reader (the Edge Function) ever touch the key.

create or replace function public.save_claude_config(p_api_key text, p_model text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(p_api_key, '') !~ '^sk-ant-' then
    -- Catches password-manager autofill garbage before it bricks the channel.
    raise exception 'La llave debe ser una API key de Anthropic (empieza con sk-ant-).';
  end if;
  insert into public.claude_config (profile_id, api_key, model, updated_at)
  values ('team', p_api_key, coalesce(nullif(p_model, ''), 'claude-opus-4-8'), now())
  on conflict (profile_id) do update
    set api_key = excluded.api_key, model = excluded.model, updated_at = now();
  update public.settings
    set claude_connected_at = now(),
        claude_model = coalesce(nullif(p_model, ''), 'claude-opus-4-8')
    where profile_id = 'team';
end;
$$;
revoke all on function public.save_claude_config(text, text) from public;
grant execute on function public.save_claude_config(text, text) to authenticated;

-- Non-sensitive connection status for the JARVIS UI.
alter table public.settings
  add column if not exists claude_connected_at timestamptz,
  add column if not exists claude_model        text default '';

notify pgrst, 'reload schema';
