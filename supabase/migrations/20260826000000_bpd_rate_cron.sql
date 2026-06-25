-- BPD exchange-rate auto-pull, made reliable with a server-side schedule.
--
-- The rate was pulled ONLY from a logged-in dealer's browser, on the first app
-- load at/after 08:00 AST, then gated off for the rest of the day
-- (shouldPullDailyRate). Two ways that silently fails to update the rate:
--   1. Banco Popular publishes the day's rate SOME time in the morning, not
--      sharply at 08:00. The first post-08:00 load (e.g. 09:02) then fetches
--      yesterday's number, persists it — and the once-a-day gate suppresses
--      every later auto-pull, so the stale figure sticks until someone clicks
--      "Actualizar ahora". (This is exactly what happened 2026-06-25.)
--   2. If nobody opens the app after 08:00 at all, no pull ever fires.
--
-- Fix: stop depending on a browser. Same engine as the IG scheduler + the LSG
-- stock refresh + the lr-catalog sweep — pg_cron pings the `bpd-rate` Edge
-- Function with `{cron:true}` (Bearer service key); the function fetches the
-- bank's published rate and persists settings.exchange_rate itself. It runs
-- hourly across the DR business morning (08:00–14:00 AST) so whenever the bank
-- publishes, the next run overwrites any too-early value with the real one. The
-- job is registered idempotently by the function (it knows its own URL + service
-- key from its env), so no project URL is ever hardcoded here.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- (Re)register the daily rate-pull cron. Called by bpd-rate with its own URL +
-- service key. Idempotent — unschedules any prior job of the same name first.
-- `0 12-18 * * *` = the top of each hour 12:00–18:00 UTC = 08:00–14:00 in the
-- Dominican Republic (UTC-4, no DST): a pull every hour through the morning the
-- bank publishes, so a stale early fetch is corrected within the hour.
create or replace function ensure_bpd_rate_cron(p_url text, p_secret text)
returns void
language plpgsql security definer set search_path = public, cron, net as $$
begin
  if exists (select 1 from cron.job where jobname = 'bpd-rate-daily') then
    perform cron.unschedule('bpd-rate-daily');
  end if;
  perform cron.schedule('bpd-rate-daily', '0 12-18 * * *',
    'select net.http_post(url:=' || quote_literal(p_url)
    || ', headers:=jsonb_build_object(''Authorization'', ' || quote_literal('Bearer ' || p_secret)
    || ', ''Content-Type'', ''application/json''), body:=''{"cron":true}''::jsonb, timeout_milliseconds:=30000);');
end $$;

revoke all on function ensure_bpd_rate_cron(text, text) from public;
grant execute on function ensure_bpd_rate_cron(text, text) to service_role;

notify pgrst, 'reload schema';
