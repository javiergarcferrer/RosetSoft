-- LSG catalog stock: the store's sellable quantity per variant (Shopify
-- inventoryQuantity), written by shopify-sync's importCatalog mode on every
-- sync. Null = imported before this column existed / not tracked; the catalog
-- PDF treats only > 0 as "en existencia".
alter table products add column if not exists stock_qty integer;

notify pgrst, 'reload schema';
