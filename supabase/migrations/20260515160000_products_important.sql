-- Parser handoff support: extra columns on `products` that the catalog
-- import script (src/lib/catalogImport.js) writes to.
--
-- `important` carries the rich "IMPORTANT:" notes the catalog prints on
-- intro pages. The schema previously had no place for it and the text
-- ended up either dropped or jammed into description; this gives it its
-- own column so the catalog UI can render it under its own heading.

alter table public.products
  add column if not exists important text default '';
