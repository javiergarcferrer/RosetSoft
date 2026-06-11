-- TWO Shopify stores, one connection each (verified via each storefront's own
-- /admin redirect — the canonical *.myshopify.com host):
--   alcover         — alcover.do → alcoversdq.myshopify.com: the store the
--                     inventory sync PUBLISHES to ("Ligne Roset Inventory").
--   lifestylegarden — lifestylegarden.do → alcoversrl.myshopify.com: the store
--                     the brand-catalog import PULLS from.
--
-- shopify_config was a single row serving both directions, so every domain
-- "fix" (20260704130000 → fg9gaq-3c, 20260704140000 → alcoversrl) just broke
-- the other one. Key the table by store; each store carries its own token.

alter table public.shopify_config
  add column if not exists store text not null default 'alcover';

alter table public.shopify_config
  drop constraint if exists shopify_config_store_check;
alter table public.shopify_config
  add constraint shopify_config_store_check check (store in ('alcover', 'lifestylegarden'));

alter table public.shopify_config drop constraint if exists shopify_config_pkey;
alter table public.shopify_config add constraint shopify_config_pkey primary key (profile_id, store);

-- The pre-existing row is the ALCOVER connection (its token was minted in that
-- store's custom app). Undo the two repoints — alcover.do answers at
-- alcoversdq.myshopify.com, the table's ORIGINAL domain; the 20260703-era
-- "fix" misdiagnosed it. Scoped so a later manual correction is never clobbered.
update public.shopify_config
   set domain = 'alcoversdq.myshopify.com', updated_at = now()
 where profile_id = 'team' and store = 'alcover'
   and domain in ('fg9gaq-3c.myshopify.com', 'alcoversrl.myshopify.com');

update public.settings
   set shopify_domain = 'alcoversdq.myshopify.com'
 where profile_id = 'team'
   and shopify_domain in ('fg9gaq-3c.myshopify.com', 'alcoversrl.myshopify.com');

-- Per-store writer. Replacing the signature needs a drop (the parameter list
-- changes); the old two-arg call shape keeps working through the default and
-- writes the alcover connection.
drop function if exists public.save_shopify_config(text, text);
create or replace function public.save_shopify_config(p_domain text, p_token text, p_store text default 'alcover')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_store not in ('alcover', 'lifestylegarden') then
    raise exception 'unknown shopify store: %', p_store;
  end if;
  insert into public.shopify_config (profile_id, store, domain, access_token, updated_at)
  values ('team', p_store, p_domain, p_token, now())
  on conflict (profile_id, store) do update
    set domain = excluded.domain, access_token = excluded.access_token, updated_at = now();
end;
$$;
revoke all on function public.save_shopify_config(text, text, text) from public;
grant execute on function public.save_shopify_config(text, text, text) to authenticated;

-- Non-sensitive mirror for the LifestyleGarden connection (the Settings UI's
-- "connected" badge; the alcover one keeps the original shopify_* columns).
alter table public.settings
  add column if not exists shopify_lsg_domain       text default '',
  add column if not exists shopify_lsg_connected_at timestamptz;

notify pgrst, 'reload schema';
