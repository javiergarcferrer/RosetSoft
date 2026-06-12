-- Stamp the inventory item a quote line was inserted from (InventoryPicker),
-- so invoicing/delivery can offer the prefilled kardex salida instead of the
-- user re-finding the item by name. Nullable; only stock-sourced lines carry
-- it. Additive + idempotent.
alter table public.quote_lines add column if not exists inventory_item_id text;

notify pgrst, 'reload schema';
