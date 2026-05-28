-- Products catalog — self-contained + idempotent.
--
-- Restored at its ORIGINAL version (20260515160000) on purpose: a parallel
-- branch shipped this version to the shared Supabase migration history, so
-- deleting the file left a "migration recorded remotely but missing locally"
-- mismatch that made the integration refuse to apply ANY pending migration
-- (which is why `products` never got created). Restoring the file repairs the
-- history match.
--
-- Made fully self-sufficient + idempotent: it CREATES the table (instead of
-- only ALTERing it like the original) so it succeeds no matter the apply
-- order, and re-running it is always safe.

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
  important   text default '',
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
