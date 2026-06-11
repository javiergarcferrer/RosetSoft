-- Dev Dashboard ONLY: the client-credentials grant is THE auth for both
-- Shopify connections; the legacy in-admin custom-app static token path is
-- REMOVED (dead feature). From here:
--   • client_id + client_secret (NOT NULL) — the app credentials pasted in
--     Configuración (one Dev Dashboard app can serve both stores).
--   • access_token + token_expires_at — the SERVER-OWNED cache of the minted
--     24h token (client credentials grant); shopify-sync refreshes it before
--     expiry and on a 401. Never written by the client.

-- Legacy token-only rows are dead connections in this world — drop them (the
-- settings "connected" mirror is cleared below so the UI tells the truth).
delete from public.shopify_config
 where client_id is null or client_secret is null;

alter table public.shopify_config
  alter column client_id set not null,
  alter column client_secret set not null;

alter table public.shopify_config
  add column if not exists token_expires_at timestamptz;

-- The either/or credential CHECK is obsolete: credentials are mandatory and
-- access_token is just a cache.
alter table public.shopify_config
  drop constraint if exists shopify_config_credential_check;

update public.settings s
   set shopify_connected_at = null
 where s.profile_id = 'team'
   and not exists (select 1 from public.shopify_config c
                   where c.profile_id = 'team' and c.store = 'alcover');
update public.settings s
   set shopify_lsg_connected_at = null
 where s.profile_id = 'team'
   and not exists (select 1 from public.shopify_config c
                   where c.profile_id = 'team' and c.store = 'lifestylegarden');

-- Writer: credentials only. Saving invalidates the token cache (new secret ⇒
-- stale token). The old token-bearing signature is dropped, not kept around.
drop function if exists public.save_shopify_config(text, text, text, text, text);
drop function if exists public.save_shopify_config(text, text, text, text);
create function public.save_shopify_config(
  p_domain        text,
  p_store         text,
  p_client_id     text,
  p_client_secret text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_store not in ('alcover', 'lifestylegarden') then
    raise exception 'unknown shopify store: %', p_store;
  end if;
  if coalesce(p_client_id, '') = '' or coalesce(p_client_secret, '') = '' then
    raise exception 'client id and client secret are required';
  end if;
  insert into public.shopify_config (profile_id, store, domain, client_id, client_secret, access_token, token_expires_at, updated_at)
  values ('team', p_store, p_domain, p_client_id, p_client_secret, null, null, now())
  on conflict (profile_id, store) do update
    set domain           = excluded.domain,
        client_id        = excluded.client_id,
        client_secret    = excluded.client_secret,
        access_token     = null,
        token_expires_at = null,
        updated_at       = now();
end;
$$;
revoke all on function public.save_shopify_config(text, text, text, text) from public;
grant execute on function public.save_shopify_config(text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
