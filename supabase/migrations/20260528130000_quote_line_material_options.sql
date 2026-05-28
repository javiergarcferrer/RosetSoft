-- Material options: present the same line in alternative upholstery materials
-- with the price delta vs. the chosen base material. Stored as a JSONB blob on
-- the line:
--   { "baseGrade": "C", "baseLabel": "PHLOX",
--     "options": [ { "grade": "S", "label": "SOFT TOUCH", "code": "4479",
--                    "swatchImageId": null } ] }
-- Deltas are DERIVED at render time from the catalog (a material's grade -> the
-- model SKU's price at that grade), never frozen here. Component-level options
-- ride inside the existing `components` JSONB and need no column.

alter table public.quote_lines
  add column if not exists material_options jsonb;

notify pgrst, 'reload schema';
