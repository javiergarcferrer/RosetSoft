-- catalog_categories(p_profile_id): the distinct product categories for a
-- profile, each with its SKU count, in ONE round-trip. The catalog browser
-- lists every category up-front (collapsed) and lazy-loads a category's
-- products only when it's opened — so it must NOT pull the whole
-- (tens-of-thousands-row) products table just to learn the category names.
-- PostgREST can't express SELECT DISTINCT / GROUP BY over its REST grammar, so
-- this server-side function does the aggregate.
--
-- security invoker (the default): the function runs as the calling user, so the
-- existing team-read RLS policy on `products` still governs what it can see.
-- Empty / whitespace / NULL categories collapse to '' so the client buckets
-- them under a single "Sin categoría" card.

-- Index-back the GROUP BY here and the per-category product fetch the browser
-- runs when a card is opened.
create index if not exists products_profile_category_idx
  on public.products (profile_id, category);

create or replace function public.catalog_categories(p_profile_id text)
returns table (category text, sku_count bigint)
language sql
stable
as $$
  select coalesce(nullif(btrim(p.category), ''), '') as category,
         count(*) as sku_count
  from public.products p
  where p.profile_id = p_profile_id
  group by 1
  order by 1;
$$;

grant execute on function public.catalog_categories(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
