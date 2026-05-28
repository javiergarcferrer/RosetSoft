-- Consolidated, self-contained guarantee that `products` exists and is exposed
-- by PostgREST. This is the single source of truth for the catalog table; the
-- earlier 20260527* products migrations are kept (additive history) but this
-- one is a brand-new pending version the migration runner has never recorded,
-- in unambiguous latest-timestamp order, that cannot error on a re-run.
--
-- Why a fresh file: the catalog import kept failing with "Could not find the
-- table 'public.products' in the schema cache". A back-dated sibling migration
-- (20260515160000) had jammed the pending chain; it's now removed. To remove
-- any remaining ambiguity about whether the chain applied, this consolidates
-- everything `products` needs into one idempotent migration: table + the two
-- added columns (quote_lines.unit_cost, products.important), RLS + policy, and
-- — belt-and-suspenders — explicit grants to the API roles so PostgREST can
-- see the table even if default privileges didn't cover it. Ends with the
-- schema-cache reload.

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

-- Columns added by later migrations — re-assert idempotently in case this runs
-- on a table created by an older variant.
alter table public.products add column if not exists important text default '';

create unique index if not exists products_profile_reference_idx
  on public.products(profile_id, reference);
create index if not exists products_profile_family_idx
  on public.products(profile_id, family_code);

alter table public.products enable row level security;
drop policy if exists products_team_all on public.products;
create policy products_team_all on public.products
  for all to authenticated using (true) with check (true);

-- PostgREST hides a table from its schema cache when the API roles have no
-- privileges on it — which surfaces as the same "not found in schema cache"
-- error as a missing table. Grant explicitly so the table is always visible.
grant all on public.products to anon, authenticated, service_role;

-- Snapshot of the product's real cost frozen onto the quote line when added
-- from the catalog (for the per-order margin view). Pure additive column.
alter table public.quote_lines
  add column if not exists unit_cost numeric;

notify pgrst, 'reload schema';
