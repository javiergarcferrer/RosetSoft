-- Containers, line-level swatches, and the vector/hero image split.
--
-- 1. Quote lines can carry a custom swatch image (overrides the catalog color swatch).
-- 2. Products gain a separate `vector_image_id` (used in all in-app views).
--    The existing `hero_image_id` becomes the PDF-only customer-facing image.
--    Past imports populated `hero_image_id` with the technical drawing from the
--    PDF — that belongs in `vector_image_id`, so we move existing values over.
-- 3. New `containers` table groups quotes for dispatch tracking.
-- 4. Settings gains a global dispatch threshold + a container number counter.

-- ---------------------------------------------------------------------------
-- 1. Per-line swatch override
-- ---------------------------------------------------------------------------
alter table public.quote_lines
  add column if not exists swatch_image_id text;

-- ---------------------------------------------------------------------------
-- 2. Split vector (in-app) from hero (PDF-only)
-- ---------------------------------------------------------------------------
alter table public.products
  add column if not exists vector_image_id text;

-- Move any pre-existing hero (imported from price-list PDF) to vector,
-- then clear the hero so users can upload a real customer-facing photo.
update public.products
   set vector_image_id = hero_image_id
 where vector_image_id is null
   and hero_image_id is not null;

update public.products
   set hero_image_id = null
 where vector_image_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Containers
-- ---------------------------------------------------------------------------
create table if not exists public.containers (
  id              text primary key,
  profile_id      text not null references public.profiles(id) on delete cascade,
  number          integer,
  name            text default '',
  code            text default '',
  status          text default 'open',  -- 'open' | 'dispatched'
  notes           text default '',
  dispatched_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists containers_profile_updated_idx
  on public.containers(profile_id, updated_at desc);
create index if not exists containers_status_idx
  on public.containers(status);

alter table public.quotes
  add column if not exists container_id text
  references public.containers(id) on delete set null;
create index if not exists quotes_container_idx on public.quotes(container_id);

-- ---------------------------------------------------------------------------
-- 4. Settings additions
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists dispatch_threshold numeric default 50000;
alter table public.settings
  add column if not exists container_counter integer default 100;

-- ---------------------------------------------------------------------------
-- RLS for containers (same single-tenant policy as everything else)
-- ---------------------------------------------------------------------------
alter table public.containers enable row level security;
drop policy if exists "team can read"  on public.containers;
drop policy if exists "team can write" on public.containers;
create policy "team can read"  on public.containers
  for select to authenticated using (true);
create policy "team can write" on public.containers
  for all to authenticated using (true) with check (true);
