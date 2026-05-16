-- Drop the normalized catalog. Each quote line now carries its own copy of
-- family / reference / name / subtype / dimensions / yardage / description /
-- page_ref / image — the canonical source is the Ligne Roset price-list PDF
-- that the user reads alongside the builder, so the app stops trying to
-- model the catalog's structure in the database.

-- 1. Add the new free-text columns on quote_lines.
ALTER TABLE quote_lines
  ADD COLUMN IF NOT EXISTS family      text,
  ADD COLUMN IF NOT EXISTS reference   text,
  ADD COLUMN IF NOT EXISTS name        text,
  ADD COLUMN IF NOT EXISTS subtype     text,
  ADD COLUMN IF NOT EXISTS dimensions  text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS yardage     text,
  ADD COLUMN IF NOT EXISTS page_ref    text,
  ADD COLUMN IF NOT EXISTS image_id    text;

-- 2. Drop the FK columns that point at the soon-to-be-deleted catalog tables
--    and the now-redundant price_override (unit_price IS the price).
ALTER TABLE quote_lines DROP COLUMN IF EXISTS product_variant_id;
ALTER TABLE quote_lines DROP COLUMN IF EXISTS material_id;
ALTER TABLE quote_lines DROP COLUMN IF EXISTS color_id;
ALTER TABLE quote_lines DROP COLUMN IF EXISTS swatch_image_id;
ALTER TABLE quote_lines DROP COLUMN IF EXISTS price_override;

-- 3. Drop the catalog tables themselves. CASCADE handles any leftover RLS
--    policies or constraints that reference them.
DROP TABLE IF EXISTS product_variants CASCADE;
DROP TABLE IF EXISTS products         CASCADE;
DROP TABLE IF EXISTS material_colors  CASCADE;
DROP TABLE IF EXISTS materials        CASCADE;
DROP TABLE IF EXISTS categories       CASCADE;
