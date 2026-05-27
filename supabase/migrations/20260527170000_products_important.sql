-- Extra column on `products`: `important` — carries the rich "IMPORTANT:"
-- notes the price list prints on intro pages, so the catalog UI can render
-- them under their own heading instead of dropping them or jamming them into
-- the description.
--
-- RE-TIMESTAMPED: this started life as 20260515160000_products_important.sql
-- (a back-dated file from a parallel branch). Because its version was OLDER
-- than already-applied migrations AND it runs before the products table is
-- even created (20260527140000_products.sql), it triggered a migration-
-- history mismatch that blocked the WHOLE pending chain — so `products` never
-- got created and the Catálogo import failed with "Could not find the table
-- 'public.products' in the schema cache". Moving it AFTER the create restores
-- a valid, in-order history. Pure additive + idempotent.

alter table public.products
  add column if not exists important text default '';

notify pgrst, 'reload schema';
