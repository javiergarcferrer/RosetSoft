-- Daily auto-pull of the Banco Popular Dominicano (BPD) USD exchange
-- rate. The dealer no longer types the rate in by hand; the `bpd-rate`
-- Edge Function fetches the bank's published compra/venta and writes it
-- to the shared team settings row (settings.bsc + settings.currency_rates).
-- This migration schedules that function to run once a day.
--
-- Time: 08:00 in Santo Domingo. America/Santo_Domingo is UTC-4 all year
-- (Atlantic Standard Time, no DST), so 08:00 local == 12:00 UTC. pg_cron
-- evaluates schedules in UTC on Supabase, hence '0 12 * * *'.
--
-- ─────────────────────────────────────────────────────────────────────
-- ONE-TIME SETUP — run once in the Supabase SQL editor (NOT committed
-- here, because the service-role key is a secret):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<your-service-role-key>',           'service_role_key');
--
-- The cron job reads both back from Vault at run time, so the secret
-- never lives in this file or in git. Until the secrets exist the job
-- still fires but the HTTP call no-ops (null url) — add them and the next
-- 12:00 UTC tick begins updating the rate. To trigger an immediate pull
-- without waiting, use the "Actualizar ahora" button in Settings.
-- ─────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-runnable: drop a previous incarnation before (re)creating it.
-- cron.unschedule() throws if the job is absent, so guard on the catalog.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'bpd-rate-daily') then
    perform cron.unschedule('bpd-rate-daily');
  end if;
end
$$;

select cron.schedule(
  'bpd-rate-daily',
  '0 12 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/bpd-rate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $cron$
);
