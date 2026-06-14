-- Instagram scheduling engine. IG's API has no native scheduling, so we run
-- our own: the client queues a row here; pg_cron fires the `ig-publish-worker`
-- Edge Function every minute, which claims due rows and publishes via
-- meta-social. (See ig-publish-worker + meta-social `publish`.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists scheduled_posts (
  id            text primary key,
  profile_id    text not null default 'team',
  status        text not null default 'queued'
                  check (status in ('queued', 'publishing', 'published', 'failed', 'canceled')),
  scheduled_at  timestamptz not null,
  payload       jsonb not null default '{}'::jsonb,
  kind          text,
  preview       text,
  ig_creation_id text,
  ig_media_id   text,
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists scheduled_posts_due_idx on scheduled_posts (status, scheduled_at);

alter table scheduled_posts enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'scheduled_posts' and policyname = 'team scheduled_posts') then
    create policy "team scheduled_posts" on scheduled_posts for all to authenticated using (true) with check (true);
  end if;
end $$;

-- Claim ONE due post atomically (FOR UPDATE SKIP LOCKED) so overlapping cron
-- ticks never double-publish; also requeue rows a crashed worker left stuck in
-- 'publishing' for >10 min. Returns the claimed row, or nothing.
create or replace function claim_due_scheduled_post()
returns scheduled_posts
language plpgsql security definer set search_path = public as $$
declare claimed scheduled_posts;
begin
  update scheduled_posts set status = 'queued', updated_at = now()
  where status = 'publishing' and updated_at < now() - interval '10 minutes';

  update scheduled_posts set status = 'publishing', attempts = attempts + 1, updated_at = now()
  where id = (
    select id from scheduled_posts
    where status = 'queued' and scheduled_at <= now()
    order by scheduled_at
    for update skip locked
    limit 1
  )
  returning * into claimed;
  return claimed;
end $$;

revoke all on function claim_due_scheduled_post() from public;
grant execute on function claim_due_scheduled_post() to service_role;

-- (Re)register the per-minute cron job that pings the worker. Called by the
-- worker itself (which knows its own URL + service key from its env), so no
-- project URL is ever hardcoded in a migration. Idempotent.
create or replace function ensure_ig_publish_cron(p_url text, p_secret text)
returns void
language plpgsql security definer set search_path = public, cron, net as $$
begin
  if exists (select 1 from cron.job where jobname = 'ig-publish-worker') then
    perform cron.unschedule('ig-publish-worker');
  end if;
  perform cron.schedule('ig-publish-worker', '* * * * *',
    'select net.http_post(url:=' || quote_literal(p_url)
    || ', headers:=jsonb_build_object(''Authorization'', ' || quote_literal('Bearer ' || p_secret)
    || ', ''Content-Type'', ''application/json''), body:=''{"cron":true}''::jsonb);');
end $$;

revoke all on function ensure_ig_publish_cron(text, text) from public;
grant execute on function ensure_ig_publish_cron(text, text) to service_role;

notify pgrst, 'reload schema';
