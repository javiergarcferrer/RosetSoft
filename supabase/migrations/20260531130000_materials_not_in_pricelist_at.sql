-- Materials: "not in the Ligne Roset price list" marker.
--
-- The compound import treats the price-list PDFs as the source of truth for
-- commercial spec (grade, wear, width, price, composition). A COMPLETE price-
-- list import (all PDFs uploaded together) flags any material it doesn't find
-- as `not_in_pricelist_at` — kept, not deleted, since it may be a website-only
-- color set or a custom/COM entry. Clears when the material reappears in a
-- later import. null = present in the price list.
alter table public.materials
  add column if not exists not_in_pricelist_at timestamptz;

notify pgrst, 'reload schema';
