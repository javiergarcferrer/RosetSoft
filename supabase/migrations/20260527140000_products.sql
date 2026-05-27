-- Product catalog — the Ligne Roset price list (thousands of SKUs) imported
-- from the supplier CSV (Susan Greenspan's "Updated Price List for Profits").
--
-- Until now lines were free-text typed from the price-list PDF. This table is
-- the searchable catalog behind "Agregar artículo": picking a product
-- autofills reference / name / family / dimensions / price AND snapshots the
-- real Cost onto the quote line for the per-order margin view.
--
-- Source columns (CSV): SKU, Description 1, Description 2, Sales Code,
-- Sales Code Description, Retail, Cost, Category Description, ...
--   reference  ← SKU            (unique per team)
--   name       ← Description 1
--   subtype    ← Description 2 (finish, dimensions stripped off)
--   dimensions ← Description 2 (the H()/D()/S()/W() tail)
--   family     ← Sales Code Description     family_code ← Sales Code
--   price_usd  ← Retail (list)              cost ← Cost (real, = Retail/divisor)
--
-- Re-import (a new price list) is a pure upsert: the importer keys the row id
-- on the SKU, so a fresh upload replaces prices in place. Single-tenant: all
-- rows scoped to the shared 'team' profile, team-write RLS like the rest.

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

-- Snapshot of the product's real cost onto the quote line at the moment it's
-- added from the catalog. Frozen per line so a later price-list update never
-- rewrites the margin of an already-accepted order. Pure additive column.
alter table public.quote_lines
  add column if not exists unit_cost numeric;

notify pgrst, 'reload schema';
