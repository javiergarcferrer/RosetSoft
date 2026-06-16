-- Materials catalog weekly auto-refresh. The fabric/leather catalog behind the
-- quote builder is kept current by the `lr-catalog` Edge Function pulling
-- ligne-roset.com. That pull was manual (Materials ▸ Importar, bundled with the
-- price-list PDF), so a fabric added or discontinued on the LR site between PDF
-- imports (which happen only every couple months) stayed invisible for weeks.
-- This runs the WEBSITE-ONLY sync on a schedule so the catalog tracks the site
-- without anyone clicking anything — new fabrics, new colors, refreshed care
-- notes; discontinued fabrics flagged only on a complete sweep (see lr-catalog
-- runWeeklySync). The price-list PDF still owns grade/price/width/composition.
--
-- Same engine as the IG scheduler + the LSG stock refresh: pg_cron pings the
-- `lr-catalog` Edge Function every Monday with `{cron:true}` (Bearer service
-- key); the function re-sweeps + merges into `materials`. The job is registered
-- idempotently by the function itself (it knows its own URL + service key from
-- its env), so no project URL is ever hardcoded here.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- (Re)register the weekly catalog-refresh cron. Called by lr-catalog with its
-- own URL + service key. Idempotent — unschedules any prior job of the same name
-- first. Mondays 12:00 UTC = 08:00 in the Dominican Republic (UTC-4), before
-- business hours so the ~1-min sweep lands while the catalog is idle.
create or replace function ensure_lr_catalog_cron(p_url text, p_secret text)
returns void
language plpgsql security definer set search_path = public, cron, net as $$
begin
  if exists (select 1 from cron.job where jobname = 'lr-catalog-weekly') then
    perform cron.unschedule('lr-catalog-weekly');
  end if;
  perform cron.schedule('lr-catalog-weekly', '0 12 * * 1',
    'select net.http_post(url:=' || quote_literal(p_url)
    || ', headers:=jsonb_build_object(''Authorization'', ' || quote_literal('Bearer ' || p_secret)
    || ', ''Content-Type'', ''application/json''), body:=''{"cron":true}''::jsonb, timeout_milliseconds:=120000);');
end $$;

revoke all on function ensure_lr_catalog_cron(text, text) from public;
grant execute on function ensure_lr_catalog_cron(text, text) to service_role;

notify pgrst, 'reload schema';
