-- Shopify catalog sync — the store mirrors IN-STOCK inventory.
--
-- The Admin API token is a secret: it lives in a WRITE-ONLY table (no client
-- SELECT), is written through a SECURITY DEFINER RPC, and is read only by the
-- `shopify-sync` Edge Function via the service role. Non-sensitive status
-- (domain + connected_at) lives on `settings` for the UI. Mirrors the
-- ecf_credentials pattern — no dashboard secret, no manual step.

create table if not exists public.shopify_config (
  profile_id   text primary key default 'team' references public.profiles(id) on delete cascade,
  domain       text not null,
  access_token text not null,
  updated_at   timestamptz not null default now()
);
alter table public.shopify_config enable row level security;
-- Intentionally NO client policies: only the SECURITY DEFINER writer below and
-- the service-role reader (the Edge Function) ever touch the token.

create or replace function public.save_shopify_config(p_domain text, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.shopify_config (profile_id, domain, access_token, updated_at)
  values ('team', p_domain, p_token, now())
  on conflict (profile_id) do update
    set domain = excluded.domain, access_token = excluded.access_token, updated_at = now();
end;
$$;
revoke all on function public.save_shopify_config(text, text) from public;
grant execute on function public.save_shopify_config(text, text) to authenticated;

-- Non-sensitive connection status for the Settings UI.
alter table public.settings
  add column if not exists shopify_domain       text default '',
  add column if not exists shopify_connected_at timestamptz;

notify pgrst, 'reload schema';
