-- togo_models — the dealer-managed Togo configurator catalog. One row per Togo
-- model the dealer uploads: a DWG converted IN-BROWSER to a top-down plan SVG,
-- bound to a Ligne Roset catalog product (product_root → family/grades) for
-- pricing. The configurator's palette reads these instead of guessing models by
-- name, so the picture catalog is explicit and reliable.
--
-- Additive + single-tenant "team can write" RLS, like the other CRM tables. The
-- converted SVG lives inline (text) — small, and it's the whole client asset, so
-- there's no Storage round-trip to render a piece.

create table if not exists public.togo_models (
  id                text primary key,
  profile_id        text not null default 'team',
  name              text not null default '',
  product_root      text,            -- bound Ligne Roset family root (8-digit SKU prefix)
  product_reference text,            -- optional specific SKU within the family
  width_cm          numeric not null default 0,
  depth_cm          numeric not null default 0,
  svg               text not null default '',
  sort_order        integer not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.togo_models enable row level security;

drop policy if exists togo_models_rw on public.togo_models;
create policy togo_models_rw on public.togo_models
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
