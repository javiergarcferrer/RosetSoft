-- Dev Dashboard (client-credentials) Shopify connections.
--
-- Shopify's current app flow (dev.shopify.com) exposes a Client ID + Client
-- secret instead of a static Admin token; the app exchanges them for a 24-hour
-- access token (grant_type=client_credentials) and re-mints as needed. The
-- legacy in-admin custom app (static shpat_ token) still exists, so a
-- connection is EITHER token-based OR credentials-based:
--   access_token              — legacy custom app (static shpat_…)
--   client_id + client_secret — Dev Dashboard app; shopify-sync mints the
--                               short-lived token server-side on each call.

alter table public.shopify_config
  alter column access_token drop not null;
alter table public.shopify_config
  add column if not exists client_id     text,
  add column if not exists client_secret text;

alter table public.shopify_config
  drop constraint if exists shopify_config_credential_check;
alter table public.shopify_config
  add constraint shopify_config_credential_check
  check (access_token is not null or (client_id is not null and client_secret is not null));

-- Writer accepts either credential shape; saving one CLEARS the other so a
-- connection never carries two conflicting auth paths. Old call shapes
-- (p_domain+p_token[+p_store]) keep working through the defaults.
drop function if exists public.save_shopify_config(text, text, text);
create or replace function public.save_shopify_config(
  p_domain        text,
  p_token         text default null,
  p_store         text default 'alcover',
  p_client_id     text default null,
  p_client_secret text default null
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
  if coalesce(p_token, '') = ''
     and (coalesce(p_client_id, '') = '' or coalesce(p_client_secret, '') = '') then
    raise exception 'provide an access token or a client id + secret';
  end if;
  insert into public.shopify_config (profile_id, store, domain, access_token, client_id, client_secret, updated_at)
  values ('team', p_store, p_domain, nullif(p_token, ''), nullif(p_client_id, ''), nullif(p_client_secret, ''), now())
  on conflict (profile_id, store) do update
    set domain        = excluded.domain,
        access_token  = excluded.access_token,
        client_id     = excluded.client_id,
        client_secret = excluded.client_secret,
        updated_at    = now();
end;
$$;
revoke all on function public.save_shopify_config(text, text, text, text, text) from public;
grant execute on function public.save_shopify_config(text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
