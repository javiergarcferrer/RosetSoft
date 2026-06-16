-- inventory_items: identity is MODEL + VARIANT, not the model code alone.
--
-- A Ligne Roset "reference" like 14100100 is a MODEL code (Mini Togo) that is
-- SHARED across fabric/colour variants — Alcantara Goya Red, Andy, Bohemian,
-- Sport Surf… are four distinct sellable products that all carry 14100100. The
-- original (profile_id, sku) unique key assumed one item per sku and rejected
-- those four rows ("Ya existe un registro…"), forcing them to collapse into one.
--
-- Replace the sku-only unique key with (profile_id, sku, name): identical pieces
-- (same model + same cover) still collapse into a single stock count, while
-- different covers coexist as their own items / Shopify listings. The Shopify
-- link is per inventory_item.id (shopify_product_id), so this doesn't affect
-- catalog sync. Existing rows already satisfied the stricter sku-only key, so
-- the looser composite key cannot conflict with current data.
drop index if exists public.inventory_items_sku_uq;

create unique index if not exists inventory_items_sku_name_uq
  on public.inventory_items(profile_id, sku, name) where sku <> '';

notify pgrst, 'reload schema';
