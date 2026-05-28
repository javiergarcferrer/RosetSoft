-- One-time catalog hygiene: collapse internal whitespace runs (and trim) in the
-- product text fields. The supplier price-list stores names with double spaces
-- ("TOGO  FIRESIDE CHAIR"), so a normal single-spaced search ("Togo Fireside
-- Chair") never matched. New imports are already squished at parse time
-- (lib/priceListCsv.squish); this cleans the rows already in the table.
-- Idempotent: only touches dirty rows, and re-running collapses nothing further.

update public.products set
  name     = regexp_replace(btrim(name),     '\s+', ' ', 'g'),
  subtype  = regexp_replace(btrim(subtype),  '\s+', ' ', 'g'),
  family   = regexp_replace(btrim(family),   '\s+', ' ', 'g'),
  category = regexp_replace(btrim(category), '\s+', ' ', 'g')
where name     is distinct from regexp_replace(btrim(name),     '\s+', ' ', 'g')
   or subtype  is distinct from regexp_replace(btrim(subtype),  '\s+', ' ', 'g')
   or family   is distinct from regexp_replace(btrim(family),   '\s+', ' ', 'g')
   or category is distinct from regexp_replace(btrim(category), '\s+', ' ', 'g');

notify pgrst, 'reload schema';
