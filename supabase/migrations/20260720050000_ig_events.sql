-- Persisted Instagram webhook events (comments + mentions). The `meta-webhook`
-- Edge Function writes a row on receipt; the Studio reads them for a live
-- activity feed instead of polling the Graph API.
create table if not exists ig_events (
  id          text primary key,
  profile_id  text not null default 'team',
  kind        text not null,           -- 'comment' | 'mention'
  object_id   text,                    -- the IG comment/media id
  media_id    text,
  username    text,
  text        text,
  permalink   text,
  payload     jsonb,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists ig_events_recent_idx on ig_events (created_at desc);

alter table ig_events enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'ig_events' and policyname = 'team ig_events') then
    create policy "team ig_events" on ig_events for all to authenticated using (true) with check (true);
  end if;
end $$;

notify pgrst, 'reload schema';
