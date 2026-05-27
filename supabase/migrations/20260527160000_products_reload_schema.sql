-- Re-ensure the products catalog table + reload the PostgREST schema cache.
--
-- The Catálogo CSV import failed with:
--   "Could not find the table 'public.products' in the schema cache"
-- i.e. PostgREST (the REST layer the Dexie-shaped client talks to) hadn't
-- picked up the table created in 20260527140000_products.sql. This migration
-- idempotently re-asserts the table / index / RLS (no-ops if they already
-- exist) and re-issues the schema reload so the REST API exposes it.
--
-- Fully additive + idempotent — safe whether the table is missing (creates
-- it) or present-but-uncached (the trailing NOTIFY reloads the cache).

create table if not exists public.products (
  id          text primary key,
  profile_id  text not null,
  reference   text not null,
  name        text,
  subtype     text,
  dimensions  text,
  family      text,
  family_code text,
  category    text,
  price_usd   numeric,
  cost        numeric,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists products_profile_reference_idx
  on public.products(profile_id, reference);
create index if not exists products_profile_family_idx
  on public.products(profile_id, family_code);

alter table public.products enable row level security;
drop policy if exists products_team_all on public.products;
create policy products_team_all on public.products
  for all to authenticated using (true) with check (true);

alter table public.quote_lines
  add column if not exists unit_cost numeric;

notify pgrst, 'reload schema';
