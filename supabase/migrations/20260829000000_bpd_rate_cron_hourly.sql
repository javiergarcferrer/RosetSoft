-- BPD rate cron: hourly across the DR business day — the watertight backbone.
--
-- History (why this exists): the rate pull flip-flopped between an hourly sweep,
-- a single daily shot, and a browser-only pull — none watertight on its own:
--   • A SINGLE daily shot (35 12 * * * = 08:35 AST) assumes the bank has
--     published by 08:35. It often hasn't — Banco Popular publishes the day's
--     rate at an UNPREDICTABLE morning time (it slipped past 08:00 on
--     2026-06-25). consultaTasa carries no as-of date, so an early pull silently
--     grabs YESTERDAY's number, persists it, and there is NO retry until
--     tomorrow. One transient BPD hiccup at 08:35 = no update all day.
--   • A BROWSER-only pull depends on a human opening the app that morning.
--
-- The bank has no webhook and the rate carries no as-of date, so the only
-- watertight strategy is to POLL often enough to converge on the latest
-- published value within the hour AND survive transient API failures with many
-- attempts. Polling is idempotent: bpd-rate refuses to persist a missing/zero
-- USD (returns 502 without writing), so re-pulling the same number is harmless.
--
-- `0 12-22 * * *` = the top of each hour 12:00–22:00 UTC = 08:00–18:00 in the
-- Dominican Republic (UTC-4, no DST): ~11 attempts spanning the whole business
-- day. A late-morning publish is caught within the hour, and a bank outage that
-- swallows every morning attempt is still recovered the same afternoon — with
-- zero browser dependency.
--
-- The browser session-pull (AppContext / shouldPullSessionRate) stays, but only
-- as instant refresh for an open session AND as the deploy/restore BOOTSTRAP
-- that first arms this cron: a migration can't know the project URL + service
-- key, so the first authenticated bpd-rate invoke (browser OR a prior cron run)
-- registers the job via ensure_bpd_rate_cron below — which then self-heals on
-- every successful pull, surviving a project restore. Same engine + idiom as the
-- IG scheduler, the LSG stock refresh, and the lr-catalog sweep.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function ensure_bpd_rate_cron(p_url text, p_secret text)
returns void
language plpgsql security definer set search_path = public, cron, net as $$
begin
  if exists (select 1 from cron.job where jobname = 'bpd-rate-daily') then
    perform cron.unschedule('bpd-rate-daily');
  end if;
  perform cron.schedule('bpd-rate-daily', '0 12-22 * * *',
    'select net.http_post(url:=' || quote_literal(p_url)
    || ', headers:=jsonb_build_object(''Authorization'', ' || quote_literal('Bearer ' || p_secret)
    || ', ''Content-Type'', ''application/json''), body:=''{"cron":true}''::jsonb, timeout_milliseconds:=30000);');
end $$;

revoke all on function ensure_bpd_rate_cron(text, text) from public;
grant execute on function ensure_bpd_rate_cron(text, text) to service_role;

notify pgrst, 'reload schema';
