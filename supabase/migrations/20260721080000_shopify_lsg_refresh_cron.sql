-- LifestyleGarden stock auto-refresh. LSG products are PULLED from the
-- lifestylegarden.do Shopify store (shopify-sync importCatalog), and that store
-- is a live storefront — its inventoryQuantity drops as products sell there.
-- The pull was manual (Settings/Catalog), so our mirrored `products.stock_qty`
-- went stale the moment something sold on Shopify. This runs the pull on a
-- schedule so the mirror stays fresh without anyone clicking anything.
--
-- Same engine as the IG scheduler: pg_cron pings the `shopify-sync` Edge
-- Function every 15 min with `{cron:true}` (Bearer service key); the function
-- re-pulls the LSG catalog. The job is registered idempotently by the function
-- itself (it knows its own URL + service key from its env), so no project URL is
-- ever hardcoded here.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- (Re)register the LSG refresh cron. Called by shopify-sync with its own URL +
-- service key. Idempotent — unschedules any prior job of the same name first.
create or replace function ensure_shopify_refresh_cron(p_url text, p_secret text)
returns void
language plpgsql security definer set search_path = public, cron, net as $$
begin
  if exists (select 1 from cron.job where jobname = 'shopify-lsg-refresh') then
    perform cron.unschedule('shopify-lsg-refresh');
  end if;
  perform cron.schedule('shopify-lsg-refresh', '*/15 * * * *',
    'select net.http_post(url:=' || quote_literal(p_url)
    || ', headers:=jsonb_build_object(''Authorization'', ' || quote_literal('Bearer ' || p_secret)
    || ', ''Content-Type'', ''application/json''), body:=''{"cron":true}''::jsonb);');
end $$;

revoke all on function ensure_shopify_refresh_cron(text, text) from public;
grant execute on function ensure_shopify_refresh_cron(text, text) to service_role;

notify pgrst, 'reload schema';
