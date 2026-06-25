-- BPD rate cron: one pull a day at 8:35 AM, not hourly.
--
-- The bank publishes the day's rate by ~08:35 AST, so a single pull then is
-- enough — no need to sweep the whole morning. Redefine ensure_bpd_rate_cron
-- with the new schedule; the Edge Function re-registers the job (idempotent
-- unschedule + reschedule) off this definition on its next successful pull, so
-- any previously-registered hourly job self-heals to the single daily run.
--
-- `35 12 * * *` = 12:35 UTC = 08:35 in the Dominican Republic (UTC-4, no DST).

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function ensure_bpd_rate_cron(p_url text, p_secret text)
returns void
language plpgsql security definer set search_path = public, cron, net as $$
begin
  if exists (select 1 from cron.job where jobname = 'bpd-rate-daily') then
    perform cron.unschedule('bpd-rate-daily');
  end if;
  perform cron.schedule('bpd-rate-daily', '35 12 * * *',
    'select net.http_post(url:=' || quote_literal(p_url)
    || ', headers:=jsonb_build_object(''Authorization'', ' || quote_literal('Bearer ' || p_secret)
    || ', ''Content-Type'', ''application/json''), body:=''{"cron":true}''::jsonb, timeout_milliseconds:=30000);');
end $$;

revoke all on function ensure_bpd_rate_cron(text, text) from public;
grant execute on function ensure_bpd_rate_cron(text, text) to service_role;

notify pgrst, 'reload schema';
