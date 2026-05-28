-- Materials: "no longer offered on the Ligne Roset site" marker.
--
-- The catalog importer (lib/lrCatalog + the lr-catalog Edge Function) can sync
-- the WHOLE catalog from ligne-roset.com with the site as source of truth. When
-- a full sync no longer finds one of our materials offered anywhere on the site
-- we KEEP it — it may carry dealer-only data the site never had (per-yard
-- price, grade, uploaded color photos) or be a custom/COM entry — but flag it
-- here so the dealer can review and remove it. A material that reappears on the
-- site clears the flag. null = active / on-site.
alter table public.materials
  add column if not exists discontinued_at timestamptz;

notify pgrst, 'reload schema';
