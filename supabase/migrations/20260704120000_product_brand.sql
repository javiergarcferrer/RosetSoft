-- Brand catalogs: `products` becomes the home of EVERY supplier catalog, not
-- just Ligne Roset. Each row carries its `brand`; every existing row is the
-- Ligne Roset price list, so the column default backfills them.
--
--   ligne-roset      — the price-list CSV import (admin Catálogos → Ligne Roset)
--   lifestylegarden  — pulled from the team's own Shopify store
--                      (www.lifestylegarden.do) by the shopify-sync Edge
--                      Function's importCatalog mode; rows keyed lsg-<variantId>
--
-- Additive + idempotent. The catalog_categories() aggregate gains an optional
-- p_brand filter so each brand's catalog page lists only its own categories;
-- the old single-arg call shape keeps working through the default.

alter table public.products
  add column if not exists brand text not null default 'ligne-roset';

create index if not exists products_profile_brand_category_idx
  on public.products (profile_id, brand, category);

-- Same body as before plus the brand filter; replacing the old signature needs
-- a drop (CREATE OR REPLACE can't add a parameter).
drop function if exists public.catalog_categories(text);

create or replace function public.catalog_categories(p_profile_id text, p_brand text default null)
returns table (category text, sku_count bigint)
language sql
stable
as $$
  select coalesce(nullif(btrim(p.category), ''), '') as category,
         count(*) as sku_count
  from public.products p
  where p.profile_id = p_profile_id
    and (p_brand is null or p.brand = p_brand)
  group by 1
  order by 1;
$$;

grant execute on function public.catalog_categories(text, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
