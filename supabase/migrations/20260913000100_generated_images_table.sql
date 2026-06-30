-- Generated images — history of ads/artwork the dealer generates with OpenAI
-- DALL·E 3. Each row is one generation request: the prompt + style note, the
-- requested dimensions/count, the dropped "inspiration" reference images
-- (jsonb), and the resulting image url + revised prompt the model returned.
-- Single-tenant team-read + team-write (the Edge Function writes results back
-- with the service role; the app reads the gallery).

create table if not exists public.generated_images (
  id              text primary key,
  profile_id      text not null references public.profiles(id) on delete cascade,
  prompt          text,
  style_note      text,
  status          text not null default 'completed'
                    check (status in ('queued','generating','completed','failed')),
  image_url       text,
  width           integer,
  height          integer,
  count           integer,
  revised_prompt  text,
  model           text default 'dall-e-3',
  inspiration     jsonb default '[]'::jsonb,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists generated_images_profile_created_idx
  on public.generated_images(profile_id, created_at desc);
create index if not exists generated_images_status_idx
  on public.generated_images(status);

-- ---------------------------------------------------------------------------
-- RLS (same single-tenant policy as everything else)
-- ---------------------------------------------------------------------------
alter table public.generated_images enable row level security;
drop policy if exists "team can read"  on public.generated_images;
drop policy if exists "team can write" on public.generated_images;
create policy "team can read"  on public.generated_images
  for select to authenticated using (true);
create policy "team can write" on public.generated_images
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
