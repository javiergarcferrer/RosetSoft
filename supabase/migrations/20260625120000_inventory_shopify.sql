-- Inventory → Shopify catalog.
--
-- The store catalog mirrors IN-STOCK inventory: one Shopify listing per
-- inventory item (identical pieces already collapse into one item with a stock
-- count via the (profile_id, sku) unique key), and an item leaves the catalog
-- when it sells out. So each item carries:
--   • selling_price      — the PERMANENT retail price set on the Alcover
--                          purchase order (NOT recomputed from cost).
--   • image_id           — a photo uploaded at RECEIVING (→ images.id). This is
--                          never a quote image; quote photos are quote-specific.
--   • shopify_product_id — the linked Shopify product gid (idempotent sync).
--   • shopify_synced_at  — last time it was pushed to Shopify.
-- All additive + nullable: non-store inventory items simply leave them empty.

alter table public.inventory_items
  add column if not exists selling_price      numeric,
  add column if not exists image_id           text references public.images(id) on delete set null,
  add column if not exists shopify_product_id text,
  add column if not exists shopify_synced_at  timestamptz;

create index if not exists inventory_items_shopify_idx
  on public.inventory_items(shopify_product_id) where shopify_product_id is not null;

notify pgrst, 'reload schema';
